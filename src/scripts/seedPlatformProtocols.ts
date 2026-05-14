/**
 * Seed de protocolos da plataforma MetaCore (scope='platform').
 * Requer que a tabela exercises já tenha sido populada (npm run seed:exercises).
 *
 * Idempotente: usa ON CONFLICT (title, scope) DO NOTHING.
 *
 * Uso: npx tsx src/scripts/seedPlatformProtocols.ts
 */

import pool from '../config/database';
import logger from '../lib/logger';

async function findExerciseByNormalizedName(name: string): Promise<string | null> {
  const normalized = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const res = await pool.query(
    `SELECT id FROM exercises WHERE normalized_name = $1 AND source = 'metacore' LIMIT 1`,
    [normalized]
  );
  return res.rows[0]?.id ?? null;
}

type ProtocolExercise = {
  name: string;
  sets: string;
  reps: string;
  rest: string;
  notes?: string;
};

type ProtocolDef = {
  title: string;
  description: string;
  tags: Record<string, unknown>;
  weekPreset: string;
  selectedGroup: string;
  exercises: ProtocolExercise[];
};

const PLATFORM_PROTOCOLS: ProtocolDef[] = [
  {
    title: 'Treino Rápido em Casa · 10 min',
    description: 'Treino funcional de 10 minutos sem equipamento, ideal para dias curtos.',
    tags: { goal: 'geral', level: 'beginner', location: 'casa' },
    weekPreset: '5',
    selectedGroup: 'Funcional',
    exercises: [
      { name: 'Agachamento Livre (Peso Corporal)', sets: '3', reps: '15', rest: '30s' },
      { name: 'Flexão de Braço', sets: '3', reps: '10', rest: '30s' },
      { name: 'Prancha', sets: '3', reps: '30s', rest: '30s' },
      { name: 'Mountain Climber', sets: '3', reps: '20', rest: '30s' },
    ],
  },
  {
    title: 'HIIT · 20 minutos',
    description: 'Circuito de alta intensidade para queima calórica em 20 minutos.',
    tags: { goal: 'emagrecimento', level: 'intermediate', location: 'casa' },
    weekPreset: '5',
    selectedGroup: 'Cardio',
    exercises: [
      { name: 'Polichinelo (Jumping Jack)', sets: '4', reps: '30s', rest: '15s' },
      { name: 'Burpee', sets: '4', reps: '10', rest: '20s' },
      { name: 'Mountain Climber', sets: '4', reps: '30s', rest: '15s' },
      { name: 'Agachamento com Salto (Jump Squat)', sets: '4', reps: '12', rest: '20s' },
    ],
  },
  {
    title: 'Full Body com Peso Corporal · 30 min',
    description: 'Treino completo usando apenas o peso do corpo — costas, peito, pernas, core.',
    tags: { goal: 'geral', level: 'intermediate', location: 'casa' },
    weekPreset: '5',
    selectedGroup: 'Full Body',
    exercises: [
      { name: 'Agachamento Livre (Peso Corporal)', sets: '4', reps: '15', rest: '60s' },
      { name: 'Flexão de Braço', sets: '4', reps: '12', rest: '60s' },
      { name: 'Afundo Reverso', sets: '3', reps: '12', rest: '60s', notes: 'Cada perna' },
      { name: 'Prancha', sets: '3', reps: '45s', rest: '45s' },
      { name: 'Twist Russo', sets: '3', reps: '20', rest: '45s' },
    ],
  },
];

async function main() {
  logger.info('[seed:protocols] Iniciando seed de protocolos da plataforma...');
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const proto of PLATFORM_PROTOCOLS) {
    try {
      const items: Array<Record<string, unknown>> = [];

      for (const ex of proto.exercises) {
        const exerciseId = await findExerciseByNormalizedName(ex.name);
        if (!exerciseId) {
          logger.warn(
            { name: ex.name },
            '[seed:protocols] Exercício não encontrado na biblioteca — item omitido'
          );
          continue;
        }
        items.push({
          exerciseId,
          name: ex.name,
          sets: ex.sets,
          reps: ex.reps,
          rest: ex.rest,
          notes: ex.notes ?? '',
        });
      }

      if (!items.length) {
        logger.warn({ title: proto.title }, '[seed:protocols] Protocolo sem itens válidos — pulando');
        skipped++;
        continue;
      }

      const res = await pool.query(
        `INSERT INTO workout_protocols
           (scope, academy_id, owner_personal_id, title, description, tags, week_preset, selected_group, payload_json, updated_at)
         VALUES ('platform', NULL, NULL, $1, $2, $3::jsonb, $4, $5, $6::jsonb, NOW())
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          proto.title,
          proto.description,
          JSON.stringify(proto.tags),
          proto.weekPreset,
          proto.selectedGroup,
          JSON.stringify(items),
        ]
      );

      if (res.rows.length) {
        inserted++;
        logger.info({ id: res.rows[0].id, title: proto.title }, '[seed:protocols] Protocolo inserido');
      } else {
        skipped++;
        logger.info({ title: proto.title }, '[seed:protocols] Protocolo já existe — pulado');
      }
    } catch (err) {
      errors++;
      logger.error({ err, title: proto.title }, '[seed:protocols] Erro ao inserir protocolo');
    }
  }

  logger.info(
    { total: PLATFORM_PROTOCOLS.length, inserted, skipped, errors },
    '[seed:protocols] Seed concluído'
  );
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, '[seed:protocols] Falha fatal');
  process.exit(1);
});
