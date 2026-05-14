import pool from '../config/database';

export type ExerciseCatalogEntry = {
  id: string;
  name: string;
  group: string;
  source: 'seed' | 'video';
  videoUrl?: string | null;
};

const SEED: ExerciseCatalogEntry[] = [
  // Perna — quadríceps, posterior, panturrilha
  { id: 'e1',  name: 'Agachamento Livre',           group: 'Perna',   source: 'seed' },
  { id: 'e2',  name: 'Leg Press 45°',               group: 'Perna',   source: 'seed' },
  { id: 'e3',  name: 'Cadeira Extensora',            group: 'Perna',   source: 'seed' },
  { id: 'e4',  name: 'Hack Squat',                   group: 'Perna',   source: 'seed' },
  { id: 'e5',  name: 'Agachamento Smith',            group: 'Perna',   source: 'seed' },
  { id: 'e6',  name: 'Mesa Flexora',                 group: 'Perna',   source: 'seed' },
  { id: 'e7',  name: 'Stiff',                        group: 'Perna',   source: 'seed' },
  { id: 'e8',  name: 'Cadeira Flexora',              group: 'Perna',   source: 'seed' },
  { id: 'e9',  name: 'Leg Curl Deitado',             group: 'Perna',   source: 'seed' },
  { id: 'e10', name: 'Panturrilha em Pé',            group: 'Perna',   source: 'seed' },
  { id: 'e11', name: 'Panturrilha Sentado',          group: 'Perna',   source: 'seed' },
  { id: 'e12', name: 'Afundo',                       group: 'Perna',   source: 'seed' },
  { id: 'e13', name: 'Leg Press Horizontal',         group: 'Perna',   source: 'seed' },
  // Glúteo — isolado do Perna para evitar confusão na IA
  { id: 'g1',  name: 'Elevação Pélvica',             group: 'Glúteo',  source: 'seed' },
  { id: 'g2',  name: 'Abdução de Quadril',           group: 'Glúteo',  source: 'seed' },
  { id: 'g3',  name: 'Coice Glúteo',                group: 'Glúteo',  source: 'seed' },
  { id: 'g4',  name: 'Agachamento Sumo',             group: 'Glúteo',  source: 'seed' },
  // Peito — nunca incluir exercícios de Glúteo ou Perna neste grupo
  { id: 'p1',  name: 'Supino Reto',                 group: 'Peito',   source: 'seed' },
  { id: 'p2',  name: 'Supino Inclinado',             group: 'Peito',   source: 'seed' },
  { id: 'p3',  name: 'Supino Declinado',             group: 'Peito',   source: 'seed' },
  { id: 'p4',  name: 'Crucifixo',                    group: 'Peito',   source: 'seed' },
  { id: 'p5',  name: 'Crucifixo Inclinado',          group: 'Peito',   source: 'seed' },
  { id: 'p6',  name: 'Crossover',                    group: 'Peito',   source: 'seed' },
  { id: 'p7',  name: 'Peck Deck',                    group: 'Peito',   source: 'seed' },
  { id: 'p8',  name: 'Supino com Halteres',          group: 'Peito',   source: 'seed' },
  { id: 'p9',  name: 'Pullover',                     group: 'Peito',   source: 'seed' },
  { id: 'p10', name: 'Flexão de Braço',              group: 'Peito',   source: 'seed' },
  // Costas
  { id: 'c1',  name: 'Puxada Frente',               group: 'Costas',  source: 'seed' },
  { id: 'c2',  name: 'Puxada Fechada',              group: 'Costas',  source: 'seed' },
  { id: 'c3',  name: 'Barra Fixa',                  group: 'Costas',  source: 'seed' },
  { id: 'c4',  name: 'Remada Curvada',              group: 'Costas',  source: 'seed' },
  { id: 'c5',  name: 'Remada Unilateral',           group: 'Costas',  source: 'seed' },
  { id: 'c6',  name: 'Remada Baixa',                group: 'Costas',  source: 'seed' },
  { id: 'c7',  name: 'Remada Cavalinho',            group: 'Costas',  source: 'seed' },
  { id: 'c8',  name: 'Pullover na Polia',            group: 'Costas',  source: 'seed' },
  // Ombro
  { id: 'o1',  name: 'Desenvolvimento',             group: 'Ombro',   source: 'seed' },
  { id: 'o2',  name: 'Desenvolvimento Halteres',    group: 'Ombro',   source: 'seed' },
  { id: 'o3',  name: 'Arnold Press',                group: 'Ombro',   source: 'seed' },
  { id: 'o4',  name: 'Elevação Lateral',            group: 'Ombro',   source: 'seed' },
  { id: 'o5',  name: 'Elevação Frontal',            group: 'Ombro',   source: 'seed' },
  { id: 'o6',  name: 'Crucifixo Inverso',           group: 'Ombro',   source: 'seed' },
  { id: 'o7',  name: 'Encolhimento',                group: 'Ombro',   source: 'seed' },
  // Bíceps
  { id: 'b1',  name: 'Rosca Direta',                group: 'Bíceps',  source: 'seed' },
  { id: 'b2',  name: 'Rosca Alternada',             group: 'Bíceps',  source: 'seed' },
  { id: 'b3',  name: 'Rosca Martelo',               group: 'Bíceps',  source: 'seed' },
  { id: 'b4',  name: 'Rosca Concentrada',           group: 'Bíceps',  source: 'seed' },
  { id: 'b5',  name: 'Rosca Scott',                 group: 'Bíceps',  source: 'seed' },
  { id: 'b6',  name: 'Rosca 21',                    group: 'Bíceps',  source: 'seed' },
  // Tríceps
  { id: 't1',  name: 'Tríceps Corda',               group: 'Tríceps', source: 'seed' },
  { id: 't2',  name: 'Tríceps Testa',               group: 'Tríceps', source: 'seed' },
  { id: 't3',  name: 'Tríceps Francês',             group: 'Tríceps', source: 'seed' },
  { id: 't4',  name: 'Tríceps Coice',               group: 'Tríceps', source: 'seed' },
  { id: 't5',  name: 'Mergulho (Tríceps)',           group: 'Tríceps', source: 'seed' },
  { id: 't6',  name: 'Tríceps Polia Alta',           group: 'Tríceps', source: 'seed' },
  // Abdômen
  { id: 'a1',  name: 'Abdominal Infra',             group: 'Abdômen', source: 'seed' },
  { id: 'a2',  name: 'Crunch',                       group: 'Abdômen', source: 'seed' },
  { id: 'a3',  name: 'Prancha',                      group: 'Abdômen', source: 'seed' },
  { id: 'a4',  name: 'Oblíquo',                      group: 'Abdômen', source: 'seed' },
  { id: 'a5',  name: 'Abdominal Máquina',           group: 'Abdômen', source: 'seed' },
  // Cardio
  { id: 'k1',  name: 'Esteira (HIIT)',              group: 'Cardio',  source: 'seed' },
  { id: 'k2',  name: 'Bicicleta Ergométrica',       group: 'Cardio',  source: 'seed' },
  { id: 'k3',  name: 'Elíptico',                    group: 'Cardio',  source: 'seed' },
];

export async function listExerciseCatalog(options: { q?: string; group?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 100);
  const q = options.q?.trim().toLowerCase() ?? '';
  const groupFilter = options.group?.trim();

  let seed = SEED;
  if (groupFilter) {
    seed = seed.filter((e) => e.group.toLowerCase() === groupFilter.toLowerCase());
  }
  if (q) {
    seed = seed.filter((e) => e.name.toLowerCase().includes(q));
  }

  const out: ExerciseCatalogEntry[] = [...seed];

  const videoLimit = Math.max(0, limit - out.length);
  if (videoLimit > 0) {
    try {
      const params: unknown[] = [];
      let where = 'WHERE 1=1';
      if (q) {
        params.push(`%${q.replace(/%/g, '')}%`);
        where += ` AND v.title ILIKE $${params.length}`;
      }
      params.push(videoLimit);
      const vres = await pool.query(
        `SELECT v.id, v.title, v.url
         FROM videos v
         ${where}
         ORDER BY v.title ASC
         LIMIT $${params.length}`,
        params
      );
      for (const row of vres.rows) {
        out.push({
          id: `v-${row.id}`,
          name: String(row.title),
          group: 'Outros',
          source: 'video',
          videoUrl: row.url ? String(row.url) : null,
        });
      }
    } catch {
      /* videos table optional in some envs */
    }
  }

  return out.slice(0, limit);
}
