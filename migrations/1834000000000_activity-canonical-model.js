/* eslint-disable camelcase */

/**
 * Modelo canônico de Atividade (SPEC Mobile P2 §4/§5/§6).
 *
 * `activity_sessions` já existia e guardava o que o Tracker do S2Core produz.
 * O que faltava era tudo que só faz sentido quando a atividade pode chegar de
 * FORA: de onde ela veio, qual o identificador dela na origem, e como não
 * gravar duas vezes a mesma corrida que chegou por dois caminhos.
 *
 * ## Deduplicação — a decisão e o porquê
 *
 * A SPEC (§5) descreve o cenário real: a mesma corrida sai do relógio, entra no
 * Health Connect e chega aqui; amanhã pode chegar também pela API do fornecedor.
 * Duas defesas, em ordem de confiança:
 *
 * 1. **`(user_id, source, source_external_id)` UNIQUE parcial.** Quando a origem
 *    dá um identificador, ele é a verdade — nada de heurística. Parcial porque
 *    atividade do próprio S2Core não tem id externo, e um UNIQUE cheio de NULL
 *    não serve para nada.
 *
 * 2. **`client_key` + `(user_id, client_key)` UNIQUE parcial.** Mesma ideia que
 *    `workout_sessions.client_key` (migration 1833000000000): o cliente gera a
 *    chave uma vez por atividade e a repete no reenvio. É o que impede um POST
 *    reenviado por timeout de virar uma segunda corrida no histórico.
 *
 * A terceira camada — janela temporal + tipo + duração, para quando NENHUM
 * identificador existe — fica no serviço, não no banco, e **nunca apaga nada**:
 * ela marca `possible_duplicate_of` para o usuário decidir. A SPEC é explícita:
 * "não usar heurística destrutiva sem documentação".
 *
 * ## Estilo: SQL cru e idempotente
 *
 * Da migration 1823 em diante o repositório usa `pgm.db.query` com SQL cru, e
 * não a API de builder. O motivo é o helper de integração
 * (`restorePerformanceSchema`), que REEXECUTA estas migrations com um `pgm`
 * mínimo — só `db.query`. Usar `pgm.createTable`/`pgm.func` quebra a suíte
 * inteira de integração, longe da causa.
 */

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE activity_sessions
      ADD COLUMN IF NOT EXISTS source                TEXT NOT NULL DEFAULT 's2core',
      ADD COLUMN IF NOT EXISTS source_external_id    TEXT,
      ADD COLUMN IF NOT EXISTS source_app            TEXT,
      ADD COLUMN IF NOT EXISTS client_key            TEXT,
      ADD COLUMN IF NOT EXISTS avg_heart_rate        INTEGER,
      ADD COLUMN IF NOT EXISTS max_heart_rate        INTEGER,
      ADD COLUMN IF NOT EXISTS calories              INTEGER,
      ADD COLUMN IF NOT EXISTS calories_source       TEXT NOT NULL DEFAULT 'estimated',
      ADD COLUMN IF NOT EXISTS elevation_gain_m      NUMERIC(8,1),
      ADD COLUMN IF NOT EXISTS possible_duplicate_of INTEGER,
      ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  // Autorreferência: a suspeita aponta para a atividade que já existia.
  await pgm.db.query(`
    ALTER TABLE activity_sessions
      DROP CONSTRAINT IF EXISTS activity_sessions_possible_duplicate_fkey
  `);
  await pgm.db.query(`
    ALTER TABLE activity_sessions
      ADD CONSTRAINT activity_sessions_possible_duplicate_fkey
      FOREIGN KEY (possible_duplicate_of) REFERENCES activity_sessions(id) ON DELETE SET NULL
  `);

  await pgm.db.query(`ALTER TABLE activity_sessions DROP CONSTRAINT IF EXISTS activity_sessions_source_chk`);
  await pgm.db.query(`
    ALTER TABLE activity_sessions ADD CONSTRAINT activity_sessions_source_chk
      CHECK (source IN ('s2core','health_connect','apple_health','garmin','strava','manual','import'))
  `);

  // §55: calorias medidas pela fonte nunca se disfarçam de estimativa nossa.
  await pgm.db.query(`ALTER TABLE activity_sessions DROP CONSTRAINT IF EXISTS activity_sessions_calories_source_chk`);
  await pgm.db.query(`
    ALTER TABLE activity_sessions ADD CONSTRAINT activity_sessions_calories_source_chk
      CHECK (calories_source IN ('device','estimated'))
  `);

  // Defesa 1: identificador da origem. Parcial — só onde ele existe.
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_activity_source_external
      ON activity_sessions (user_id, source, source_external_id)
      WHERE source_external_id IS NOT NULL
  `);

  // Defesa 2: reenvio do mesmo POST não cria uma segunda atividade.
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_activity_client_key
      ON activity_sessions (user_id, client_key)
      WHERE client_key IS NOT NULL
  `);

  // Leitura do histórico unificado (§39) e da janela de dedup por tempo.
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_user_started
      ON activity_sessions (user_id, started_at)
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS idx_activity_user_started`);
  await pgm.db.query(`DROP INDEX IF EXISTS uniq_activity_client_key`);
  await pgm.db.query(`DROP INDEX IF EXISTS uniq_activity_source_external`);
  await pgm.db.query(`ALTER TABLE activity_sessions DROP CONSTRAINT IF EXISTS activity_sessions_calories_source_chk`);
  await pgm.db.query(`ALTER TABLE activity_sessions DROP CONSTRAINT IF EXISTS activity_sessions_source_chk`);
  await pgm.db.query(`ALTER TABLE activity_sessions DROP CONSTRAINT IF EXISTS activity_sessions_possible_duplicate_fkey`);
  await pgm.db.query(`
    ALTER TABLE activity_sessions
      DROP COLUMN IF EXISTS source,
      DROP COLUMN IF EXISTS source_external_id,
      DROP COLUMN IF EXISTS source_app,
      DROP COLUMN IF EXISTS client_key,
      DROP COLUMN IF EXISTS avg_heart_rate,
      DROP COLUMN IF EXISTS max_heart_rate,
      DROP COLUMN IF EXISTS calories,
      DROP COLUMN IF EXISTS calories_source,
      DROP COLUMN IF EXISTS elevation_gain_m,
      DROP COLUMN IF EXISTS possible_duplicate_of,
      DROP COLUMN IF EXISTS updated_at
  `);
};
