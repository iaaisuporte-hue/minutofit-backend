import pool from '../config/database';

export async function ensureWorkoutProtocolsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workout_protocols (
      id SERIAL PRIMARY KEY,
      scope VARCHAR(16) NOT NULL
        CHECK (scope IN ('personal', 'academy', 'platform')),
      academy_id INTEGER REFERENCES academies(id) ON DELETE CASCADE,
      owner_personal_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      tags JSONB NOT NULL DEFAULT '{}'::jsonb,
      week_preset VARCHAR(32) NOT NULL DEFAULT '5',
      selected_group VARCHAR(64),
      payload_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- 'personal' exige DONO, não academia: personal autônomo tem academy_id
      -- NULL por design (isolamento por owner_personal_id). Ver migration
      -- 1819000000000 — o predicado antigo quebrava todo save de ficha do
      -- autônomo, porque createPersonalProtocolSnapshot grava com academy_id nulo.
      CONSTRAINT workout_protocols_scope_academy_chk CHECK (
        (scope = 'platform' AND academy_id IS NULL)
        OR (scope = 'academy' AND academy_id IS NOT NULL)
        OR (scope = 'personal' AND owner_personal_id IS NOT NULL)
      )
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workout_protocols_scope_academy
    ON workout_protocols (scope, academy_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_workout_protocols_owner
    ON workout_protocols (owner_personal_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS personal_protocol_favorites (
      personal_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      protocol_id INTEGER NOT NULL REFERENCES workout_protocols(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (personal_id, protocol_id)
    )
  `);

  const seed = await pool.query(`SELECT 1 FROM workout_protocols WHERE scope = 'platform' LIMIT 1`);
  if (seed.rows.length === 0) {
    const regenItems = [
      {
        exerciseId: 'e4',
        name: 'Mesa Flexora',
        sets: '3',
        reps: '12-15',
        rest: '60s',
        notes: 'Descarga — amplitude completa, sem compensação lombar.',
      },
      {
        exerciseId: 'k1',
        name: 'Esteira (caminhada leve)',
        sets: '1',
        reps: '20 min',
        rest: '—',
        notes: 'Zona 1–2; foco em recuperação ativa.',
      },
      {
        exerciseId: 'a1',
        name: 'Abdominal Infra',
        sets: '3',
        reps: '15-20',
        rest: '45s',
        notes: 'Respiração diafragmática.',
      },
    ];
    const hypertrophyItems = [
      {
        exerciseId: 'e2',
        name: 'Agachamento Livre',
        sets: '4',
        reps: '8-10',
        rest: '120s',
        notes: 'Profundidade controlada; joelho alinhado ao pé.',
      },
      {
        exerciseId: 'e3',
        name: 'Leg Press 45°',
        sets: '3',
        reps: '10-12',
        rest: '90s',
        notes: 'Amplitude completa sem travar joelho.',
      },
      {
        exerciseId: 'p1',
        name: 'Supino Reto',
        sets: '4',
        reps: '8-10',
        rest: '90s',
        notes: 'Escápulas estáveis.',
      },
    ];
    await pool.query(
      `INSERT INTO workout_protocols
        (scope, academy_id, owner_personal_id, title, description, tags, week_preset, selected_group, payload_json)
       VALUES
        ('platform', NULL, NULL, 'Descarga regenerativa (S2Core)', 'Modelo curado para semanas de baixa recuperação ou fadiga acumulada.',
         $1::jsonb, '4', 'Perna', $2::jsonb),
        ('platform', NULL, NULL, 'Base hipertrofia membros (S2Core)', 'Volume moderado com ênfase em pernas e peito — progressão linear.',
         $3::jsonb, '5', 'Perna', $4::jsonb)`,
      [
        JSON.stringify({
          goal: 'recuperacao',
          level: 'iniciante',
          location: 'academia',
          metabolicFocus: 'regenerativo',
          injurySafe: true,
        }),
        JSON.stringify(regenItems),
        JSON.stringify({
          goal: 'hipertrofia',
          level: 'intermediario',
          location: 'academia',
          metabolicFocus: 'moderado',
          injurySafe: false,
        }),
        JSON.stringify(hypertrophyItems),
      ]
    );
  }
}
