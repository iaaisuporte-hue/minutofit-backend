import pool from '../config/database';

export type ExerciseCatalogEntry = {
  id: string;
  name: string;
  group: string;
  source: 'seed' | 'video';
  videoUrl?: string | null;
};

const SEED: ExerciseCatalogEntry[] = [
  { id: 'e1', name: 'Cadeira Extensora', group: 'Perna', source: 'seed', videoUrl: '/videos/cadeira-extensora.mp4' },
  { id: 'e2', name: 'Agachamento Livre', group: 'Perna', source: 'seed', videoUrl: '/videos/agachamento-livre.mp4' },
  { id: 'e3', name: 'Leg Press 45°', group: 'Perna', source: 'seed', videoUrl: '/videos/leg-press-45.mp4' },
  { id: 'e4', name: 'Mesa Flexora', group: 'Perna', source: 'seed', videoUrl: '/videos/mesa-flexora.mp4' },
  { id: 'e5', name: 'Panturrilha em Pé', group: 'Perna', source: 'seed', videoUrl: '/videos/panturrilha-em-pe.mp4' },
  { id: 'e6', name: 'Panturrilha Sentado', group: 'Perna', source: 'seed', videoUrl: '/videos/panturrilha-sentado.mp4' },
  { id: 'p1', name: 'Supino Reto', group: 'Peito', source: 'seed', videoUrl: '/videos/supino-reto.mp4' },
  { id: 'p2', name: 'Supino Inclinado', group: 'Peito', source: 'seed', videoUrl: '/videos/supino-inclinado.mp4' },
  { id: 'p3', name: 'Crucifixo', group: 'Peito', source: 'seed', videoUrl: '/videos/crucifixo.mp4' },
  { id: 'c1', name: 'Puxada Frente', group: 'Costas', source: 'seed', videoUrl: '/videos/puxada-frente.mp4' },
  { id: 'c2', name: 'Remada Curvada', group: 'Costas', source: 'seed', videoUrl: '/videos/remada-curvada.mp4' },
  { id: 'c3', name: 'Remada Baixa', group: 'Costas', source: 'seed', videoUrl: '/videos/remada-baixa.mp4' },
  { id: 'o1', name: 'Desenvolvimento', group: 'Ombro', source: 'seed', videoUrl: '/videos/desenvolvimento.mp4' },
  { id: 'o2', name: 'Elevação Lateral', group: 'Ombro', source: 'seed', videoUrl: '/videos/elevacao-lateral.mp4' },
  { id: 'b1', name: 'Rosca Direta', group: 'Bíceps', source: 'seed', videoUrl: '/videos/rosca-direta.mp4' },
  { id: 't1', name: 'Tríceps Corda', group: 'Tríceps', source: 'seed', videoUrl: '/videos/triceps-corda.mp4' },
  { id: 'a1', name: 'Abdominal Infra', group: 'Abdômen', source: 'seed', videoUrl: '/videos/abdominal-infra.mp4' },
  { id: 'g1', name: 'Elevação pélvica', group: 'Glúteo', source: 'seed' },
  { id: 'k1', name: 'Esteira (HIIT)', group: 'Cardio', source: 'seed', videoUrl: '/videos/esteira-hiit.mp4' },
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
