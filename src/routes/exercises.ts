/**
 * Rotas da biblioteca global de exercícios CoreFit.
 *
 * GET  /api/exercises                          — search (autenticado)
 * GET  /api/exercises/batch                    — batch by IDs (autenticado)
 * GET  /api/exercises/:id                      — detalhe (autenticado)
 * POST /api/exercises                          — criar (admin only)
 * PATCH /api/exercises/:id                     — atualizar (admin only)
 */

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { roleCheckMiddleware } from '../middleware/auth';
import {
  searchExercises,
  getExerciseById,
  getExercisesBatch,
  adminCreateExercise,
  adminPatchExercise,
} from '../services/exerciseLibraryService';
import pool from '../config/database';
import logger from '../lib/logger';

const router = Router();

/**
 * Resolve o personal "dono do contexto" de quem está buscando (Sprint P1,
 * D4) — SEMPRE no servidor, nunca por query param do cliente. Personal vê a
 * própria biblioteca; aluno vê a do personal atualmente atribuído (no máximo
 * um, por `uniq_active_personal_per_student`); qualquer outro caso (admin,
 * aluno sem personal) devolve `null` — só catálogo global.
 */
async function resolveViewerPersonalId(req: Request): Promise<number | null> {
  if (req.user!.role === 'personal') return req.user!.id;
  if (req.user!.role !== 'user') return null;

  const { rows } = await pool.query<{ personal_id: number }>(
    `SELECT personal_id FROM personal_student_assignments
      WHERE student_id = $1 AND status = 'active'
      LIMIT 1`,
    [req.user!.id],
  );
  return rows[0]?.personal_id ?? null;
}

// GET /api/exercises?q=supino&bodyPart=peito&equipment=barra&limit=50
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const bodyPart = typeof req.query.bodyPart === 'string' ? req.query.bodyPart : undefined;
    const equipment = typeof req.query.equipment === 'string' ? req.query.equipment : undefined;
    const limit = req.query.limit ? Math.min(Number(req.query.limit) || 50, 1000) : 50;
    const offset = req.query.offset ? Math.max(Number(req.query.offset) || 0, 0) : 0;

    const tagsRaw = req.query.tags;
    const tags = Array.isArray(tagsRaw)
      ? tagsRaw.map(String)
      : typeof tagsRaw === 'string'
        ? tagsRaw.split(',').filter(Boolean)
        : undefined;

    const viewerPersonalId = await resolveViewerPersonalId(req);
    const exercises = await searchExercises({ q, bodyPart, equipment, tags, limit, offset, viewerPersonalId });
    // `total` era `exercises.length` — o tamanho da PÁGINA, não o total da
    // busca. Qualquer paginação construída em cima disso pararia na primeira
    // página. Enquanto `searchExercises` não devolve a contagem real, expomos
    // o que de fato temos e sinalizamos se há mais.
    res.json({
      exercises,
      count: exercises.length,
      hasMore: exercises.length === limit,
      /** @deprecated tamanho da página, não o total da busca. Use `count`/`hasMore`. */
      total: exercises.length,
    });
  } catch (err: unknown) {
    logger.error({ err }, 'GET /api/exercises error');
    res.status(500).json({ error: 'Erro ao buscar exercícios' });
  }
});

// GET /api/exercises/batch?ids=uuid1,uuid2,...
router.get('/batch', authMiddleware, async (req: Request, res: Response) => {
  try {
    const idsRaw = req.query.ids;
    const ids: string[] = Array.isArray(idsRaw)
      ? idsRaw.map(String)
      : typeof idsRaw === 'string'
        ? idsRaw.split(',').filter(Boolean)
        : [];

    if (!ids.length) {
      return res.json({ exercises: [] });
    }
    if (ids.length > 100) {
      return res.status(400).json({ error: 'Máximo de 100 IDs por batch' });
    }

    const exercises = await getExercisesBatch(ids);
    res.json({ exercises });
  } catch (err: unknown) {
    logger.error({ err }, 'GET /api/exercises/batch error');
    res.status(500).json({ error: 'Erro ao buscar exercícios em batch' });
  }
});

// GET /api/exercises/:id
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const exercise = await getExerciseById(id);
    if (!exercise) return res.status(404).json({ error: 'Exercício não encontrado' });

    res.json({ exercise });
  } catch (err: unknown) {
    logger.error({ err }, 'GET /api/exercises/:id error');
    res.status(500).json({ error: 'Erro ao buscar exercício' });
  }
});

// POST /api/exercises — admin only
router.post('/', authMiddleware, roleCheckMiddleware('admin'), async (req: Request, res: Response) => {
  try {
    const {
      name, bodyPart, targetMuscle, secondaryMuscles,
      equipment, tags, instructions, tips, externalId, source,
    } = req.body;

    if (!name || !bodyPart || !targetMuscle || !equipment) {
      return res.status(400).json({ error: 'name, bodyPart, targetMuscle, equipment são obrigatórios' });
    }

    const exercise = await adminCreateExercise({
      name: String(name).slice(0, 255),
      bodyPart: String(bodyPart).slice(0, 100),
      targetMuscle: String(targetMuscle).slice(0, 200),
      secondaryMuscles: Array.isArray(secondaryMuscles) ? secondaryMuscles.map(String) : [],
      equipment: String(equipment).slice(0, 100),
      tags: Array.isArray(tags) ? tags.map(String) : [],
      instructions: Array.isArray(instructions) ? instructions.map(String) : [],
      tips: Array.isArray(tips) ? tips.map(String) : [],
      externalId: externalId ? String(externalId) : null,
      source: source ? String(source) : 'corefit',
    });

    res.status(201).json({ exercise });
  } catch (err: unknown) {
    logger.error({ err }, 'POST /api/exercises error');
    res.status(500).json({ error: 'Erro ao criar exercício' });
  }
});

// PATCH /api/exercises/:id — admin only
router.patch('/:id', authMiddleware, roleCheckMiddleware('admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const exercise = await adminPatchExercise(id, req.body);
    if (!exercise) return res.status(404).json({ error: 'Exercício não encontrado' });

    res.json({ exercise });
  } catch (err: unknown) {
    logger.error({ err }, 'PATCH /api/exercises/:id error');
    res.status(500).json({ error: 'Erro ao atualizar exercício' });
  }
});

export default router;
