/**
 * Onda 4 MaaS — sinais secundários do check-in diário.
 *
 * Adiciona 3 colunas opt-in (nullable) ao user_daily_checkins para capturar
 * sinais contextuais que alimentam a inteligência metabólica:
 *   - hydration_ok       — booleano (Sim / Não / null)
 *   - nutrition_level    — 'poor' | 'ok' | 'good' | null
 *   - mental_load_level  — 'low'  | 'medium' | 'high' | null
 *
 * Compatíveis com check-in primário em 1 tap (feeling) — usuário motivado
 * pode expandir e dar mais 3 sinais sem ser obrigado.
 */

exports.up = (pgm) => {
  pgm.addColumns('user_daily_checkins', {
    hydration_ok: { type: 'boolean', notNull: false },
    nutrition_level: {
      type: 'varchar(20)',
      notNull: false,
      check: "nutrition_level IS NULL OR nutrition_level IN ('poor', 'ok', 'good')",
    },
    mental_load_level: {
      type: 'varchar(20)',
      notNull: false,
      check: "mental_load_level IS NULL OR mental_load_level IN ('low', 'medium', 'high')",
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('user_daily_checkins', [
    'hydration_ok',
    'nutrition_level',
    'mental_load_level',
  ]);
};
