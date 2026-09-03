/**
 * Biblioteca de Exercícios Personalizados do Personal (Sprint P1).
 *
 * `exercises` ganha DONO (`owner_personal_id`) e CICLO DE VIDA (`status`) sem
 * virar catálogo paralelo — D1 do plano: `assertExercisesExist`, PR tracking,
 * histórico e a P0 inteira (substituição/adição, Bi-Set, execução) já operam
 * sobre `exercises.id`, então reusar a tabela dá tudo isso de graça.
 *
 * `owner_personal_id` é `ON DELETE SET NULL` de propósito — mas SOZINHO isso
 * repetiria o bug documentado no CLAUDE.md (02/ago): a linha viraria
 * global-visível para todo mundo ao excluir a conta do personal. Por isso
 * `accountDeletionService.ts` arquiva (`status='archived'`) todo exercício do
 * personal ANTES do DELETE de `users` — quando o SET NULL disparar, a linha já
 * não aparece em busca nenhuma (D6).
 *
 * `UNIQUE(normalized_name, source)` era literal e global — dois personais
 * diferentes com exercício de mesmo nome colidiriam na constraint (D2). Vira
 * dois índices únicos PARCIAIS: o antigo escopado a `owner_personal_id IS
 * NULL` (zero mudança de comportamento — toda linha hoje já satisfaz essa
 * condição, porque a coluna não existia) e um novo escopado a cada personal.
 * `adminCreateExercise`'s `ON CONFLICT` precisa casar exatamente o predicado
 * do índice parcial (`exerciseLibraryService.ts`).
 *
 * Correção pós-revisão (mesmo dia): o índice do personal também entra
 * `AND status = 'active'` no predicado. Sem isso, um nome ARQUIVADO ficaria
 * bloqueado para sempre — nenhum outro exercício do mesmo personal poderia
 * nascer com aquele nome, mesmo o original nunca mais aparecendo em busca
 * nenhuma. Com o predicado escopado a `active`: dois exercícios ATIVOS do
 * mesmo personal continuam não podendo ter o mesmo nome (a regra que
 * importa); arquivar libera o nome para reuso imediato; e restaurar um
 * exercício arquivado enquanto outro ativo já ocupa o nome volta a entrar no
 * escopo do índice e colide de propósito (D12 — mensagem 409 clara).
 *
 * Segunda correção (achada pelo teste de exclusão de conta, mesmo dia): o
 * índice GLOBAL (`exercises_name_source_uq`) precisa da MESMA amarra de
 * status, por um motivo diferente do de cima. D6 arquiva o exercício do
 * personal ANTES de excluir a conta, e só DEPOIS o `ON DELETE SET NULL`
 * dispara — nesse instante a linha (já arquivada) entra no escopo do índice
 * GLOBAL (`owner_personal_id IS NULL`). Sem `AND status = 'active'` aqui
 * também, dois personais que batizassem um exercício com o MESMO nome
 * (plausível — nomes genéricos como "Supino Reto" colidem fácil) e depois
 * excluíssem a conta em momentos diferentes fariam a SEGUNDA exclusão
 * estourar 500 na constraint, travada por uma linha órfã e arquivada de
 * OUTRO personal que nem existe mais. Escopar por `active` não muda nada do
 * catálogo global hoje (nenhum código arquiva exercício `corefit`/
 * `metacore`), e faz uma linha arquivada — de personal ou global — parar de
 * competir por espaço no índice de qualquer um dos dois lados.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE exercises
      ADD COLUMN IF NOT EXISTS owner_personal_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  `);
  await pgm.db.query(`
    ALTER TABLE exercises
      ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active'
  `);

  await pgm.db.query(`
    ALTER TABLE exercises DROP CONSTRAINT IF EXISTS chk_exercises_status
  `);
  await pgm.db.query(`
    ALTER TABLE exercises ADD CONSTRAINT chk_exercises_status
      CHECK (status IN ('active', 'archived'))
  `);

  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_exercises_owner_personal
      ON exercises (owner_personal_id)
      WHERE owner_personal_id IS NOT NULL
  `);

  // Converte a UNIQUE global em índice único parcial (mesmo nome, mesmo
  // efeito hoje) e cria o par escopado por dono. Precisa dropar a constraint
  // ANTES de criar o índice de mesmo nome.
  await pgm.db.query(`
    ALTER TABLE exercises DROP CONSTRAINT IF EXISTS exercises_name_source_uq
  `);
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS exercises_name_source_uq
      ON exercises (normalized_name, source)
      WHERE owner_personal_id IS NULL AND status = 'active'
  `);
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS exercises_personal_owner_name_uq
      ON exercises (owner_personal_id, normalized_name)
      WHERE owner_personal_id IS NOT NULL AND status = 'active'
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  // Índices parciais primeiro — a UNIQUE não-parcial original exige
  // (normalized_name, source) único em TODA a tabela, sem escopo de dono nem
  // de status. Down de produção com dois personais tendo repetido um nome
  // (ativo ou já arquivado) falharia aqui; aceitável — não é um caminho
  // comum, e falhar alto é melhor que apagar biblioteca de personal
  // silenciosamente.
  await pgm.db.query(`DROP INDEX IF EXISTS exercises_personal_owner_name_uq`);
  await pgm.db.query(`DROP INDEX IF EXISTS exercises_name_source_uq`);
  await pgm.db.query(`
    ALTER TABLE exercises ADD CONSTRAINT exercises_name_source_uq
      UNIQUE (normalized_name, source)
  `);

  await pgm.db.query(`DROP INDEX IF EXISTS idx_exercises_owner_personal`);

  await pgm.db.query(`ALTER TABLE exercises DROP CONSTRAINT IF EXISTS chk_exercises_status`);
  await pgm.db.query(`ALTER TABLE exercises DROP COLUMN IF EXISTS status`);
  await pgm.db.query(`ALTER TABLE exercises DROP COLUMN IF EXISTS owner_personal_id`);
};
