/**
 * Rotas da Biblioteca de Exercícios Personalizados do Personal (Sprint P1),
 * `/api/personal/exercises/*`.
 *
 * Router próprio, montado no MESMO prefixo de `personal.ts` (mesmo padrão de
 * `personalFinance.ts` — `personal.ts` já passa de 2 mil linhas). Precisa
 * vir DEPOIS de `personalRoutes` no `index.ts`: o `roleCheckMiddleware`
 * aplicado a nível de router abaixo responderia 403 a qualquer outra role em
 * TODO `/api/personal/*` se montado antes.
 *
 * `personal_id` sai SEMPRE de `req.user!.id` — nunca do path ou do corpo.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';

import { authMiddleware, roleCheckMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import { StorageNotConfiguredError } from '../lib/storage';
import {
  archivePersonalExercise,
  createExerciseMediaUploadTarget,
  createPersonalExercise,
  deleteExerciseMedia,
  listPersonalExercises,
  registerExerciseMedia,
  registerExerciseYoutubeLink,
  restorePersonalExercise,
  updatePersonalExercise,
  type PersonalExerciseInput,
  type PersonalExercisePatch,
} from '../services/personalExerciseService';

const router = Router();

router.use(authMiddleware, requireProduct('personal'), roleCheckMiddleware('personal'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(name: string) {
  return (_req: Request, res: Response, next: NextFunction, value: string) => {
    if (!UUID_RE.test(value)) {
      return res.status(400).json({ success: false, error: `invalid_${name}` });
    }
    return next();
  };
}
router.param('exerciseId', uuidParam('exerciseId'));
router.param('mediaId', uuidParam('mediaId'));

/** Erros do serviço carregam `status` (`fail()` em personalExerciseService.ts). */
function sendError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof StorageNotConfiguredError) {
    res.status(503).json({ success: false, error: 'storage_unavailable' });
    return;
  }
  const status = typeof (error as any)?.status === 'number' ? (error as any).status : 500;
  const message = status === 500 ? fallback : (error as Error).message;
  res.status(status).json({ success: false, error: message });
}

function readExerciseBody(body: any): PersonalExerciseInput | PersonalExercisePatch {
  const out: PersonalExercisePatch = {};
  if (body?.name !== undefined) out.name = body.name;
  if (body?.bodyPart !== undefined) out.bodyPart = body.bodyPart;
  if (body?.targetMuscle !== undefined) out.targetMuscle = body.targetMuscle;
  if (body?.secondaryMuscles !== undefined) out.secondaryMuscles = body.secondaryMuscles;
  if (body?.equipment !== undefined) out.equipment = body.equipment;
  if (body?.tags !== undefined) out.tags = body.tags;
  if (body?.instructions !== undefined) out.instructions = body.instructions;
  if (body?.tips !== undefined) out.tips = body.tips;
  return out;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

router.get('/exercises', async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    const status = statusRaw === 'active' || statusRaw === 'archived' ? statusRaw : 'all';
    const limit = req.query.limit ? Math.min(Number(req.query.limit) || 50, 200) : 50;
    const offset = req.query.offset ? Math.max(Number(req.query.offset) || 0, 0) : 0;

    const exercises = await listPersonalExercises(req.user!.id, { q, status, limit, offset });
    res.json({ success: true, data: { exercises } });
  } catch (error) {
    sendError(res, error, 'Falha ao listar seus exercícios.');
  }
});

router.post('/exercises', async (req: Request, res: Response) => {
  try {
    const input = readExerciseBody(req.body) as PersonalExerciseInput;
    const exercise = await createPersonalExercise(req.user!.id, input);
    res.status(201).json({ success: true, data: { exercise } });
  } catch (error) {
    sendError(res, error, 'Falha ao criar o exercício.');
  }
});

router.patch('/exercises/:exerciseId', async (req: Request, res: Response) => {
  try {
    const patch = readExerciseBody(req.body);
    const exercise = await updatePersonalExercise(req.user!.id, req.params.exerciseId, patch);
    res.json({ success: true, data: { exercise } });
  } catch (error) {
    sendError(res, error, 'Falha ao atualizar o exercício.');
  }
});

router.post('/exercises/:exerciseId/archive', async (req: Request, res: Response) => {
  try {
    const exercise = await archivePersonalExercise(req.user!.id, req.params.exerciseId);
    res.json({ success: true, data: { exercise } });
  } catch (error) {
    sendError(res, error, 'Falha ao arquivar o exercício.');
  }
});

router.post('/exercises/:exerciseId/restore', async (req: Request, res: Response) => {
  try {
    const exercise = await restorePersonalExercise(req.user!.id, req.params.exerciseId);
    res.json({ success: true, data: { exercise } });
  } catch (error) {
    sendError(res, error, 'Falha ao restaurar o exercício.');
  }
});

// ---------------------------------------------------------------------------
// Mídia — presigned de 2 passos (imagem) OU link do YouTube, dispatch por
// `kind` no corpo do POST de registro.
// ---------------------------------------------------------------------------

router.post('/exercises/:exerciseId/media/upload-url', async (req: Request, res: Response) => {
  try {
    const { contentType, byteSize } = req.body ?? {};
    if (typeof contentType !== 'string') {
      return res.status(400).json({ success: false, error: 'content_type_required' });
    }
    const target = await createExerciseMediaUploadTarget(
      req.user!.id,
      req.params.exerciseId,
      contentType,
      Number(byteSize),
    );
    res.json({ success: true, data: target });
  } catch (error) {
    sendError(res, error, 'Falha ao preparar o upload.');
  }
});

router.post('/exercises/:exerciseId/media', async (req: Request, res: Response) => {
  try {
    const { kind, storageKey, url, isPrimary } = req.body ?? {};
    if (kind === 'upload') {
      if (typeof storageKey !== 'string') {
        return res.status(400).json({ success: false, error: 'storage_key_required' });
      }
      await registerExerciseMedia(req.user!.id, req.params.exerciseId, {
        storageKey,
        isPrimary: isPrimary === true,
      });
    } else if (kind === 'youtube') {
      if (typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'url_required' });
      }
      await registerExerciseYoutubeLink(req.user!.id, req.params.exerciseId, {
        url,
        isPrimary: isPrimary === true,
      });
    } else {
      return res.status(400).json({ success: false, error: 'invalid_kind' });
    }
    res.status(201).json({ success: true });
  } catch (error) {
    sendError(res, error, 'Falha ao registrar a mídia.');
  }
});

router.delete('/exercises/:exerciseId/media/:mediaId', async (req: Request, res: Response) => {
  try {
    await deleteExerciseMedia(req.user!.id, req.params.exerciseId, req.params.mediaId);
    res.json({ success: true });
  } catch (error) {
    sendError(res, error, 'Falha ao remover a mídia.');
  }
});

export default router;
