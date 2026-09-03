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
 *    reenviado por timeout de virar uma segunda corrida no histórico — a lição
 *    que a P0 aprendeu no treino e que vale igual aqui.
 *
 * A terceira camada — janela temporal + tipo + duração, para quando NENHUM
 * identificador existe — fica no serviço, não no banco, e **nunca apaga nada**:
 * ela marca `possible_duplicate_of` para o usuário decidir. A SPEC é explícita:
 * "não usar heurística destrutiva sem documentação".
 *
 * ## O que NÃO entra aqui
 *
 * Frequência cardíaca e calorias de fonte externa entram como colunas próprias
 * e com `calories_source`, porque a §55 proíbe substituir silenciosamente um
 * dado medido por uma estimativa nossa. `calories_estimated` (que já existia) é
 * a nossa conta; `calories` é o que a fonte disse.
 */

exports.up = (pgm) => {
  pgm.addColumns('activity_sessions', {
    /**
     * De onde a atividade veio. `s2core` para o que o app gravou; os demais
     * para ingestão externa. TEXT com CHECK em vez de ENUM: acrescentar uma
     * origem nova não deve exigir ALTER TYPE em produção.
     */
    source: {
      type: 'text',
      notNull: true,
      default: 's2core',
    },
    /** Identificador da atividade NA ORIGEM. Null para o que nasceu aqui. */
    source_external_id: { type: 'text' },
    /**
     * Origem real por trás da origem (§51). Ex.: `source = 'health_connect'` e
     * `source_app = 'Garmin Connect'`. Guardado desde já porque a P3 vai
     * precisar distinguir a qualidade do dado por fabricante.
     */
    source_app: { type: 'text' },
    /** Chave de idempotência gerada pelo cliente. Ver bloco acima. */
    client_key: { type: 'text' },
    /** FC média/máxima quando a fonte fornece. Nunca calculadas por nós. */
    avg_heart_rate: { type: 'integer' },
    max_heart_rate: { type: 'integer' },
    /** Calorias informadas pela FONTE (§55). Distintas de calories_estimated. */
    calories: { type: 'integer' },
    /**
     * De onde vem o número de calorias exibido: `device` (a fonte mediu) ou
     * `estimated` (nossa conta por MET). Sem isto, um dado medido e uma
     * estimativa ficariam indistinguíveis na tela e no histórico.
     */
    calories_source: { type: 'text', notNull: true, default: 'estimated' },
    /** Altimetria acumulada, quando a fonte fornece (§17). */
    elevation_gain_m: { type: 'numeric(8,1)' },
    /**
     * Suspeita de duplicata resolvida por heurística temporal. Aponta para a
     * atividade que já existia. Nunca apaga — quem decide é o usuário (§5).
     */
    possible_duplicate_of: {
      type: 'integer',
      references: 'activity_sessions',
      onDelete: 'SET NULL',
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.addConstraint('activity_sessions', 'activity_sessions_source_chk', {
    check: `source IN ('s2core','health_connect','apple_health','garmin','strava','manual','import')`,
  });

  pgm.addConstraint('activity_sessions', 'activity_sessions_calories_source_chk', {
    check: `calories_source IN ('device','estimated')`,
  });

  // Defesa 1: identificador da origem. Parcial — só onde ele existe.
  pgm.createIndex('activity_sessions', ['user_id', 'source', 'source_external_id'], {
    name: 'uniq_activity_source_external',
    unique: true,
    where: 'source_external_id IS NOT NULL',
  });

  // Defesa 2: reenvio do mesmo POST não cria uma segunda atividade.
  pgm.createIndex('activity_sessions', ['user_id', 'client_key'], {
    name: 'uniq_activity_client_key',
    unique: true,
    where: 'client_key IS NOT NULL',
  });

  // Leitura do histórico unificado (§39) e da janela de dedup por tempo.
  pgm.createIndex('activity_sessions', ['user_id', 'started_at'], {
    name: 'idx_activity_user_started',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('activity_sessions', ['user_id', 'started_at'], { name: 'idx_activity_user_started' });
  pgm.dropIndex('activity_sessions', ['user_id', 'client_key'], { name: 'uniq_activity_client_key' });
  pgm.dropIndex('activity_sessions', ['user_id', 'source', 'source_external_id'], {
    name: 'uniq_activity_source_external',
  });
  pgm.dropConstraint('activity_sessions', 'activity_sessions_calories_source_chk');
  pgm.dropConstraint('activity_sessions', 'activity_sessions_source_chk');
  pgm.dropColumns('activity_sessions', [
    'source',
    'source_external_id',
    'source_app',
    'client_key',
    'avg_heart_rate',
    'max_heart_rate',
    'calories',
    'calories_source',
    'elevation_gain_m',
    'possible_duplicate_of',
    'updated_at',
  ]);
};
