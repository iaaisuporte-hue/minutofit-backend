import type { WorkoutPlanItemPayload, TechniqueType } from '../../../services/personalWorkoutPlanService';
import type { AdaptationPolicy, AdaptationChange, AdaptationResult, RecoverySuggestion } from './types';
import type { ReadinessLevel } from '../../readiness/readiness.engine';

// ── Private parsers (fail-safe: return null on unparseable) ────────────────

function parseLeadingInt(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseRepRange(s: string | undefined): { lo: number; hi: number } | null {
  if (!s) return null;
  const range = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (range) return { lo: parseInt(range[1], 10), hi: parseInt(range[2], 10) };
  const single = s.match(/^(\d+)$/);
  if (single) { const n = parseInt(single[1], 10); return { lo: n, hi: n }; }
  return null;
}

function parseSeconds(s: string | undefined): number | null {
  if (!s) return null;
  const mins = s.match(/^(\d+(?:\.\d+)?)\s*m(?:in)?$/i);
  if (mins) return Math.round(parseFloat(mins[1]) * 60);
  const secs = s.match(/^(\d+(?:\.\d+)?)\s*s(?:ec)?$/i);
  if (secs) return Math.round(parseFloat(secs[1]));
  const num = s.match(/^(\d+)$/);
  if (num) return parseInt(num[1], 10);
  return null;
}

function parseRpe(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return v >= 1 && v <= 10 ? v : null;
}

function formatSeconds(n: number): string {
  if (n % 60 === 0 && n >= 60) return `${n / 60}min`;
  return `${n}s`;
}

// ── Technique tier ordering (lower index = lower intensity) ────────────────
const TECHNIQUE_TIER: ReadonlyMap<TechniqueType, number> = new Map([
  ['none', 0],
  ['rest_pause', 1],
  ['bi_set', 2],
  ['drop_set', 3],
]);

// ── CREF safety guard ──────────────────────────────────────────────────────

export function assertSafeAdaptation(
  original: WorkoutPlanItemPayload[],
  adapted: WorkoutPlanItemPayload[],
): void {
  if (adapted.length !== original.length) {
    throw new Error(`CREF violation: item count changed (${original.length} → ${adapted.length})`);
  }
  for (let i = 0; i < original.length; i++) {
    const o = original[i];
    const a = adapted[i];
    if (a.exerciseId !== o.exerciseId) {
      throw new Error(`CREF violation: exerciseId changed at index ${i}`);
    }
    if (a.name !== o.name) {
      throw new Error(`CREF violation: name changed at index ${i}`);
    }
    // sets must not increase
    const oSets = parseLeadingInt(o.sets);
    const aSets = parseLeadingInt(a.sets);
    if (oSets !== null && aSets !== null && aSets > oSets) {
      throw new Error(`CREF violation: sets increased at index ${i} (${o.sets} → ${a.sets})`);
    }
    // rpe must not increase
    const oRpe = parseRpe(o.rpe);
    const aRpe = parseRpe(a.rpe);
    if (oRpe !== null && aRpe !== null && aRpe > oRpe) {
      throw new Error(`CREF violation: rpe increased at index ${i} (${o.rpe} → ${a.rpe})`);
    }
    // reps hi must not increase
    const oReps = parseRepRange(o.reps);
    const aReps = parseRepRange(a.reps);
    if (oReps !== null && aReps !== null && aReps.hi > oReps.hi) {
      throw new Error(`CREF violation: reps.hi increased at index ${i} (${o.reps} → ${a.reps})`);
    }
    // rest can only increase (not decrease)
    const oRest = parseSeconds(o.rest);
    const aRest = parseSeconds(a.rest);
    if (oRest !== null && aRest !== null && aRest < oRest) {
      throw new Error(`CREF violation: rest decreased at index ${i} (${o.rest} → ${a.rest})`);
    }
    // technique can only go down in tier
    const oTier = TECHNIQUE_TIER.get(o.technique?.type ?? 'none') ?? 0;
    const aTier = TECHNIQUE_TIER.get(a.technique?.type ?? 'none') ?? 0;
    if (aTier > oTier) {
      throw new Error(`CREF violation: technique upgraded at index ${i}`);
    }
  }
}

// ── Core transformer ───────────────────────────────────────────────────────

export function adaptWorkoutDay(
  items: WorkoutPlanItemPayload[],
  level: ReadinessLevel,
  policy: AdaptationPolicy,
): AdaptationResult {
  if (level === 'green' || !policy.masterEnabled) {
    return {
      adaptedItems: items,
      changes: [],
      recoverySuggestion: null,
      appliedLevel: level,
      policyVersion: policy.version,
    };
  }

  const adapted = items.map(item => ({ ...item }));
  const changes: AdaptationChange[] = [];
  const isRed = level === 'red';

  const reasonSuffix = isRed
    ? 'Estado vermelho — recuperação priorizada'
    : 'Estado amarelo — carga reduzida';

  for (let i = 0; i < adapted.length; i++) {
    const orig = items[i];
    const a = adapted[i];

    // ── Volume (sets) ──────────────────────────────────────────────────────
    if (policy.allowVolumeReduction) {
      const origSets = parseLeadingInt(orig.sets);
      if (origSets !== null) {
        const floor = Math.max(1, Math.ceil(origSets * (1 - policy.maxSetReductionPct / 100)));
        const reduction = isRed ? 2 : 1;
        const raw = origSets - reduction;
        const newSets = Math.max(floor, raw);
        if (newSets < origSets) {
          a.sets = String(newSets);
          changes.push({ exerciseId: orig.exerciseId, field: 'sets', original: orig.sets, adapted: a.sets, reason: reasonSuffix });
        }
      }
    }

    // ── Reps (collapse to lower bound of range) ────────────────────────────
    if (policy.allowVolumeReduction) {
      const rr = parseRepRange(orig.reps);
      if (rr && rr.lo < rr.hi) {
        a.reps = String(rr.lo);
        changes.push({ exerciseId: orig.exerciseId, field: 'reps', original: orig.reps, adapted: a.reps, reason: reasonSuffix });
      }
    }

    // ── Rest ───────────────────────────────────────────────────────────────
    if (policy.allowRestIncrease) {
      const origRest = parseSeconds(orig.rest);
      if (origRest !== null) {
        const factor = isRed ? 1.30 : 1.15;
        const cap = Math.round(origRest * (1 + policy.maxRestIncreasePct / 100));
        const newRest = Math.min(cap, Math.round(origRest * factor));
        if (newRest > origRest) {
          const newRestStr = formatSeconds(newRest);
          a.rest = newRestStr;
          changes.push({ exerciseId: orig.exerciseId, field: 'rest', original: orig.rest, adapted: newRestStr, reason: 'Recuperação priorizada' });
        }
      }
    }

    // ── Intensity (RPE) ────────────────────────────────────────────────────
    if (policy.allowIntensityReduction && orig.rpe) {
      const origRpe = parseRpe(orig.rpe);
      if (origRpe !== null) {
        const floor = Math.round(origRpe * policy.minIntensityPct / 100);
        const newRpe = isRed ? floor : Math.max(floor, origRpe - 1);
        if (newRpe < origRpe) {
          a.rpe = String(newRpe);
          changes.push({ exerciseId: orig.exerciseId, field: 'rpe', original: orig.rpe, adapted: a.rpe, reason: reasonSuffix });
        }
      }
    }

    // ── Technique downgrade ────────────────────────────────────────────────
    if (policy.allowIntensityReduction && orig.technique && orig.technique.type !== 'none') {
      a.technique = { type: 'none' };
      changes.push({ exerciseId: orig.exerciseId, field: 'technique', original: orig.technique.type, adapted: 'none', reason: 'Técnica avançada rebaixada — reduz fadiga' });
    }
  }

  // ── Recovery suggestion (additive only, no item substitution) ────────────
  let recoverySuggestion: RecoverySuggestion | null = null;
  if (isRed) {
    if (policy.allowActiveRecoverySubstitution) {
      recoverySuggestion = { kind: 'active_recovery', microcopy: 'Considere uma sessão leve de recuperação ativa: caminhada 20–30 min, bicicleta ergométrica leve ou alongamento dinâmico.' };
    } else if (policy.allowMobilitySuggestion) {
      recoverySuggestion = { kind: 'mobility', microcopy: 'Que tal complementar com 10–15 min de mobilidade e alongamento ao final?' };
    }
  }

  return {
    adaptedItems: adapted,
    changes,
    recoverySuggestion,
    appliedLevel: level,
    policyVersion: policy.version,
  };
}
