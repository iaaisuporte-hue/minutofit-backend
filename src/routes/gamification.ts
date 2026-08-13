import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireProduct } from '../middleware/productGate';
import {
  getGamificationSummary,
  recordGamificationCheckin,
  type WellbeingSignals,
} from '../services/gamificationService';
import { requireFeature } from '../middleware/featureGate';
import { requirePhysicalActivityClearance } from '../middleware/requirePhysicalActivityClearance';

/**
 * Booleano tolerante, mas não ingênuo. `Boolean("false")` é `true` em JS, então
 * um cliente que enviasse `sleptWell: "false"` gravava "dormiu bem" — sinal
 * invertido alimentando o score metabólico e o motor de risco do personal.
 * Aceita as formas comuns de serialização e devolve null no que não reconhece.
 */
function toBoolOrNull(value: unknown): boolean | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'sim') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'nao' || v === 'não') return false;
  }
  return null;
}

const router = Router();
// requireAcademyContext removido: standalone user tem gamification (XP, streak)
// armazenado por user_id. getGamificationSummary aceita academyId null.
router.use(authMiddleware, requireProduct('app'));

// P0-6 da auditoria: XP/streak/histórico do PRÓPRIO usuário são sinal de
// aderência (mesma família de wellbeing/workout), não capacidade premium — e
// o plano Free não concede 'workout_history', o que bloquearia o Today de um
// aluno grátis. Fica livre (só requireProduct('app')), coerente com o
// GET /user/workout-history, que já é aberto, e com a lógica de check-ins abaixo.
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const academyId = req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null;
    const data = await getGamificationSummary(req.user!.id, false, academyId);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load gamification summary' });
  }
});

router.post(
  '/checkins',
  // Valida a origem ANTES dos gates. Sem isso, um `source` desconhecido caía no
  // gate de feature e voltava 403 "Disponivel em um plano superior ao Free" —
  // uma oferta de upgrade como resposta a um payload malformado.
  (req: Request, res: Response, next: NextFunction) => {
    const src = req.body?.source;
    if (src !== 'workout' && src !== 'activity' && src !== 'wellbeing') {
      return res.status(400).json({ success: false, error: 'Invalid check-in source' });
    }
    return next();
  },
  (req: Request, res: Response, next: NextFunction) => {
    // wellbeing e workout são sinais essenciais de aderência — não devem
    // estar atrás do gate de Activity Tracker GPS. Só 'activity' (GPS)
    // exige o feature 'tracker'.
    const src = req.body?.source;
    if (src === 'wellbeing' || src === 'workout') return next();
    return requireFeature('tracker')(req, res, next);
  },
  // PAR-Q clearance: apenas workout e activity exigem assinatura válida.
  // wellbeing fica aberto (Flutter + aderência não requerem clearance).
  (req: Request, res: Response, next: NextFunction) => {
    const src = req.body?.source;
    if (src === 'wellbeing') return next();
    return requirePhysicalActivityClearance()(req, res, next);
  },
  async (req: Request, res: Response) => {
    try {
      const source = req.body.source;

      if (source !== 'workout' && source !== 'activity' && source !== 'wellbeing') {
        return res.status(400).json({ success: false, error: 'Invalid check-in source' });
      }

      if (source === 'wellbeing') {
        const s = req.body.signals;
        if (!s || typeof s !== 'object') {
          return res.status(400).json({ success: false, error: 'Wellbeing check-in requires signals' });
        }
        const hasSignal =
          s.feeling != null ||
          s.sleptWell != null ||
          s.inPain != null ||
          s.stressed != null ||
          s.hydrationOk != null ||
          s.nutritionLevel != null ||
          s.mentalLoadLevel != null ||
          (typeof s.notes === 'string' && s.notes.trim().length > 0);
        if (!hasSignal) {
          return res.status(400).json({ success: false, error: 'At least one wellbeing signal is required' });
        }
      }

      if (source === 'workout' && !req.body.workout) {
        return res.status(400).json({ success: false, error: 'Workout payload required' });
      }

      if (req.user?.accessProfile === 'clientes_sb' && source === 'activity') {
        return res.status(403).json({ success: false, error: 'Activity check-ins are not available for this profile' });
      }

      if (source === 'activity' && !req.body.activity) {
        return res.status(400).json({ success: false, error: 'Activity payload required' });
      }

      const rawSig = req.body.signals;
      let signals: WellbeingSignals | null = null;
      if (rawSig && typeof rawSig === 'object') {
        const feelingRaw = rawSig.feeling;
        let feeling: 'tired' | 'neutral' | 'energized' | null = null;
        if (feelingRaw === 'tired' || feelingRaw === 'neutral' || feelingRaw === 'energized') {
          feeling = feelingRaw;
        } else if (feelingRaw === 'normal') {
          feeling = 'neutral';
        }
        const nutritionRaw = rawSig.nutritionLevel;
        const nutritionLevel =
          nutritionRaw === 'poor' || nutritionRaw === 'ok' || nutritionRaw === 'good' ? nutritionRaw : null;
        const mentalRaw = rawSig.mentalLoadLevel;
        const mentalLoadLevel =
          mentalRaw === 'low' || mentalRaw === 'medium' || mentalRaw === 'high' ? mentalRaw : null;
        signals = {
          feeling,
          sleptWell: toBoolOrNull(rawSig.sleptWell),
          inPain: toBoolOrNull(rawSig.inPain),
          stressed: toBoolOrNull(rawSig.stressed),
          hydrationOk: toBoolOrNull(rawSig.hydrationOk),
          nutritionLevel,
          mentalLoadLevel,
          notes: typeof rawSig.notes === 'string' ? rawSig.notes : null,
        };
      }

      const data = await recordGamificationCheckin({
        userId: req.user!.id,
        academyId: req.user!.activeAcademyId ?? req.tenantHost?.academyId ?? null,
        source,
        // `xp` do corpo é IGNORADO desde a Onda C0 (Spec 034): o valor sai do
        // ledger no servidor. Clientes antigos ainda mandam o campo — não é
        // erro, é só dado que ninguém lê.
        workout: req.body.workout,
        activity: req.body.activity,
        signals,
      });

      res.status(201).json({ success: true, data });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message || 'Failed to persist gamification event' });
    }
  },
);

export default router;
