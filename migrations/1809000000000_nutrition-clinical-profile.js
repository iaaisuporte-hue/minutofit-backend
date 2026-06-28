/**
 * Perfil Clínico-Nutricional (Spec 019).
 *
 * Estrutura "catálogo + item polimórfico" para alergias, intolerâncias,
 * restrições, preferências, condições clínicas e medicamentos do paciente.
 *
 * - dietary_profile_catalog: itens padronizados que o nutri seleciona (evita
 *   texto livre; alimenta BI/IA/checagem de incompatibilidade via match_terms).
 * - patient_dietary_profile_items: o que cada paciente tem (catálogo ou "Outro").
 *
 * Inclui seed curado PT-BR (idempotente) e backfill do novo escopo de consent
 * `clinical_nutrition` para vínculos nutri↔paciente que já têm `nutrition`.
 */

const KIND_CHECK = `kind IN ('allergy','intolerance','restriction','preference','clinical_condition','medication')`;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  // ── Catálogo ────────────────────────────────────────────────────────────────
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS dietary_profile_catalog (
      id          SERIAL PRIMARY KEY,
      kind        VARCHAR(24)  NOT NULL CHECK (${KIND_CHECK}),
      code        VARCHAR(48)  NOT NULL,
      name        VARCHAR(120) NOT NULL,
      description TEXT,
      match_terms TEXT,
      is_default  BOOLEAN      NOT NULL DEFAULT true,
      active      BOOLEAN      NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (kind, code)
    )
  `);

  // ── Itens do paciente ───────────────────────────────────────────────────────
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS patient_dietary_profile_items (
      id              SERIAL PRIMARY KEY,
      patient_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by      INTEGER     NOT NULL REFERENCES users(id),
      academy_id      INTEGER     REFERENCES academies(id) ON DELETE SET NULL,
      kind            VARCHAR(24) NOT NULL CHECK (${KIND_CHECK}),
      catalog_id      INTEGER     REFERENCES dietary_profile_catalog(id) ON DELETE SET NULL,
      custom_label    VARCHAR(120),
      severity        VARCHAR(12) CHECK (severity IS NULL OR severity IN ('mild','moderate','severe')),
      preference_kind VARCHAR(10) CHECK (preference_kind IS NULL OR preference_kind IN ('like','avoid')),
      notes           VARCHAR(280),
      metadata        JSONB,
      status          VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT pdpi_origin_chk CHECK (catalog_id IS NOT NULL OR custom_label IS NOT NULL)
    )
  `);

  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_pdpi_patient_status ON patient_dietary_profile_items (patient_id, status)`);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_pdpi_patient_kind   ON patient_dietary_profile_items (patient_id, kind)`);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_pdpi_created_by     ON patient_dietary_profile_items (created_by)`);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS idx_pdpi_catalog        ON patient_dietary_profile_items (catalog_id)`);

  // ── Seed curado PT-BR ───────────────────────────────────────────────────────
  // match_terms: termos normalizados (lowercase, sem acento aplicado no service)
  // usados na checagem de incompatibilidade contra a dieta.
  const seed = [
    // kind, code, name, match_terms
    // Alergias (severidade é por-paciente, não no catálogo)
    ['allergy', 'milk', 'Leite', 'leite,lactose,whey,queijo,iogurte,manteiga,creme de leite,caseina'],
    ['allergy', 'egg', 'Ovo', 'ovo,clara,gema,maionese,albumina'],
    ['allergy', 'peanut', 'Amendoim', 'amendoim,pacoca,pasta de amendoim'],
    ['allergy', 'tree_nuts', 'Castanhas e nozes', 'castanha,noz,nozes,amendoa,avela,pistache,caju'],
    ['allergy', 'soy', 'Soja', 'soja,tofu,shoyu,edamame,lecitina de soja'],
    ['allergy', 'wheat', 'Trigo', 'trigo,farinha de trigo,pao,massa,gluten'],
    ['allergy', 'fish', 'Peixe', 'peixe,salmao,atum,tilapia,sardinha,bacalhau'],
    ['allergy', 'shellfish', 'Frutos do mar', 'camarao,caranguejo,lagosta,marisco,frutos do mar,lula,polvo'],
    ['allergy', 'sesame', 'Gergelim', 'gergelim,tahine'],
    // Intolerâncias
    ['intolerance', 'lactose', 'Lactose', 'leite,lactose,queijo,iogurte,sorvete,creme de leite'],
    ['intolerance', 'gluten', 'Glúten', 'gluten,trigo,cevada,centeio,malte,pao,massa'],
    ['intolerance', 'fructose', 'Frutose', 'frutose,mel,xarope de milho,maca,pera'],
    ['intolerance', 'caffeine', 'Cafeína', 'cafe,cafeina,energetico,cha preto'],
    ['intolerance', 'histamine', 'Histamina', 'queijo curado,vinho,embutidos,fermentados,enlatados'],
    // Restrições
    ['restriction', 'vegan', 'Vegano', 'carne,frango,peixe,ovo,leite,mel,queijo,gelatina'],
    ['restriction', 'vegetarian', 'Vegetariano', 'carne,frango,peixe,frutos do mar'],
    ['restriction', 'pescatarian', 'Pescetariano', 'carne,frango,bovino,suino'],
    ['restriction', 'gluten_free', 'Sem glúten', 'gluten,trigo,cevada,centeio,pao,massa,cerveja'],
    ['restriction', 'lactose_free', 'Sem lactose', 'leite,lactose,queijo,iogurte,creme de leite'],
    ['restriction', 'halal', 'Halal', 'porco,bacon,presunto,linguica,alcool'],
    ['restriction', 'kosher', 'Kosher', 'porco,camarao,frutos do mar'],
    ['restriction', 'low_carb', 'Low carb', 'acucar,pao,arroz,massa,batata,doce'],
    ['restriction', 'no_pork', 'Sem carne de porco', 'porco,bacon,presunto,linguica,pernil'],
    ['restriction', 'no_red_meat', 'Sem carne vermelha', 'carne vermelha,boi,bovino,suino,cordeiro'],
    // Preferências/aversões comuns (a maioria é "Outro")
    ['preference', 'coriander', 'Coentro', 'coentro'],
    ['preference', 'liver', 'Fígado', 'figado'],
    ['preference', 'mushroom', 'Cogumelo', 'cogumelo,champignon,shitake'],
    ['preference', 'eggplant', 'Berinjela', 'berinjela'],
    ['preference', 'okra', 'Quiabo', 'quiabo'],
    // Condições clínicas (informativo; match_terms para alertas leves)
    ['clinical_condition', 'diabetes_t1', 'Diabetes tipo 1', 'acucar,doce,refrigerante'],
    ['clinical_condition', 'diabetes_t2', 'Diabetes tipo 2', 'acucar,doce,refrigerante,massa'],
    ['clinical_condition', 'hypertension', 'Hipertensão', 'sal,sodio,embutidos,enlatados'],
    ['clinical_condition', 'dyslipidemia', 'Dislipidemia', 'gordura saturada,fritura,banha'],
    ['clinical_condition', 'gerd', 'Refluxo (DRGE)', 'cafe,fritura,pimenta,alcool,chocolate'],
    ['clinical_condition', 'ibs', 'Síndrome do intestino irritável', ''],
    ['clinical_condition', 'celiac', 'Doença celíaca', 'gluten,trigo,cevada,centeio,malte'],
    ['clinical_condition', 'ckd', 'Doença renal crônica', 'sodio,potassio,proteina,banana'],
    ['clinical_condition', 'hypothyroidism', 'Hipotireoidismo', ''],
    ['clinical_condition', 'gout', 'Gota', 'carne vermelha,frutos do mar,alcool,visceras'],
    ['clinical_condition', 'pregnancy', 'Gestação', 'alcool,peixe cru,embutidos'],
    // Medicamentos com possível impacto alimentar (nota de apoio)
    ['medication', 'warfarin', 'Varfarina', 'couve,espinafre,brocolis'],
    ['medication', 'metformin', 'Metformina', ''],
    ['medication', 'levothyroxine', 'Levotiroxina', 'cafe,soja,calcio'],
    ['medication', 'maoi', 'IMAO', 'queijo curado,vinho,embutidos'],
    ['medication', 'statin', 'Estatina', 'toranja,grapefruit'],
    ['medication', 'omeprazole', 'Omeprazol', ''],
  ];

  const values = [];
  const params = [];
  seed.forEach((row, i) => {
    const base = i * 4;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    params.push(row[0], row[1], row[2], row[3] || null);
  });

  await pgm.db.query(
    `INSERT INTO dietary_profile_catalog (kind, code, name, match_terms)
     VALUES ${values.join(', ')}
     ON CONFLICT (kind, code) DO NOTHING`,
    params,
  );

  // ── Escopo de consent clinical_nutrition no CHECK ───────────────────────────
  // A coluna user_data_consents.scope tem CHECK enumerado (criado em 1790600000000,
  // estendido em 1792000000000 p/ 'sports'). É preciso adicionar 'clinical_nutrition'
  // ANTES do backfill, senão o INSERT viola a constraint e a migration faz rollback.
  await pgm.db.query(`ALTER TABLE user_data_consents DROP CONSTRAINT IF EXISTS user_data_consents_scope_check`);
  await pgm.db.query(`
    ALTER TABLE user_data_consents ADD CONSTRAINT user_data_consents_scope_check
    CHECK (scope IN (
      'profile','workouts','daily_checkins','metabolic','sleep',
      'body_metrics','body_photos','nutrition','clinical_nutrition',
      'parq_anamnese','activity_logs','chat_history','sports'
    ))
  `);

  // ── Backfill consent clinical_nutrition ─────────────────────────────────────
  // Vínculos que já têm `nutrition` granted ganham `clinical_nutrition` granted,
  // para não introduzir consent_required em relacionamentos legados.
  // Idempotente: ON CONFLICT preserva escopos já concedidos/revogados.
  await pgm.db.query(`
    INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
    SELECT user_id, professional_id, 'nutri', 'clinical_nutrition', 'granted'
    FROM user_data_consents
    WHERE professional_role = 'nutri' AND scope = 'nutrition' AND status = 'granted'
    ON CONFLICT (user_id, professional_id, professional_role, scope) DO NOTHING
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS patient_dietary_profile_items`);
  await pgm.db.query(`DROP TABLE IF EXISTS dietary_profile_catalog`);
  // Restaura o CHECK sem 'clinical_nutrition' (remove primeiro os consents desse
  // escopo para não violar a constraint). Backfill de dados não tem rollback fino.
  await pgm.db.query(`DELETE FROM user_data_consents WHERE scope = 'clinical_nutrition'`);
  await pgm.db.query(`ALTER TABLE user_data_consents DROP CONSTRAINT IF EXISTS user_data_consents_scope_check`);
  await pgm.db.query(`
    ALTER TABLE user_data_consents ADD CONSTRAINT user_data_consents_scope_check
    CHECK (scope IN (
      'profile','workouts','daily_checkins','metabolic','sleep',
      'body_metrics','body_photos','nutrition','parq_anamnese',
      'activity_logs','chat_history','sports'
    ))
  `);
};
