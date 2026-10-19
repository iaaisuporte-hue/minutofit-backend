/**
 * S2CORE NUTRI P0 (Spec 039) — metas diárias prescritas pelo nutri.
 *
 * Fonte única: `nutrition_patient_goals` (1 linha por paciente). O painel do
 * aluno, o Resumo do nutri e o diário (via `resolveNutritionTarget`) leem
 * daqui — ninguém guarda cópia.
 *
 * `parseNutritionGoalsInput` é puro e é a ÚNICA validação de forma/limite;
 * os CHECKs da migration 1845 repetem os limites como última barreira, não
 * como validação de UX (erro de CHECK viraria 500 sem nome de campo).
 */
import pool from '../config/database';

export const GOAL_OBJECTIVES = [
  'weight_loss',
  'muscle_gain',
  'metabolic_health',
  'performance',
  'maintenance',
] as const;
export type GoalObjective = (typeof GOAL_OBJECTIVES)[number];

export const GOAL_LIMITS = {
  energyKcal: { min: 800, max: 6000 },
  proteinG: { min: 1, max: 400 },
  fiberG: { min: 1, max: 100 },
  waterMl: { min: 500, max: 8000 },
  noteMaxLength: 500,
  maxObjectives: 3,
} as const;

export interface NutritionGoalsInput {
  energyKcal: number | null;
  proteinMinG: number | null;
  proteinMaxG: number | null;
  fiberMinG: number | null;
  fiberMaxG: number | null;
  waterMinMl: number | null;
  waterMaxMl: number | null;
  objectives: GoalObjective[];
  patientNote: string | null;
}

export interface NutritionGoals extends NutritionGoalsInput {
  updatedAt: string;
  updatedByName: string | null;
}

export type ParseGoalsResult =
  | { ok: true; value: NutritionGoalsInput }
  | { ok: false; field: string; error: string };

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * `undefined`/`null` = sem meta. Qualquer outra coisa precisa ser número
 * finito — string numérica é recusada de propósito (mesma regra do
 * Financeiro F4: coagir na borda grava valor diferente do enviado).
 */
function readOptionalNumber(
  body: Record<string, unknown>,
  field: string,
  limits: { min: number; max: number },
  label: string,
  unit: string,
  normalize: (n: number) => number
): { ok: true; value: number | null } | { ok: false; field: string; error: string } {
  const raw = body[field];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, field, error: `${label} deve ser um número` };
  }
  const value = normalize(raw);
  if (value < limits.min || value > limits.max) {
    return { ok: false, field, error: `${label} deve estar entre ${limits.min} e ${limits.max} ${unit}` };
  }
  return { ok: true, value };
}

export function parseNutritionGoalsInput(input: unknown): ParseGoalsResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, field: 'body', error: 'Corpo da requisição inválido' };
  }
  const body = input as Record<string, unknown>;

  const fields = [
    ['energyKcal', GOAL_LIMITS.energyKcal, 'Calorias', 'kcal', round1],
    ['proteinMinG', GOAL_LIMITS.proteinG, 'Proteína mínima', 'g', round1],
    ['proteinMaxG', GOAL_LIMITS.proteinG, 'Proteína máxima', 'g', round1],
    ['fiberMinG', GOAL_LIMITS.fiberG, 'Fibra mínima', 'g', round1],
    ['fiberMaxG', GOAL_LIMITS.fiberG, 'Fibra máxima', 'g', round1],
    ['waterMinMl', GOAL_LIMITS.waterMl, 'Água mínima', 'ml', Math.round],
    ['waterMaxMl', GOAL_LIMITS.waterMl, 'Água máxima', 'ml', Math.round],
  ] as const;

  const values: Record<string, number | null> = {};
  for (const [field, limits, label, unit, normalize] of fields) {
    const parsed = readOptionalNumber(body, field, limits, label, unit, normalize);
    if (!parsed.ok) return parsed;
    values[field] = parsed.value;
  }

  const ranges = [
    ['protein', 'proteinMinG', 'proteinMaxG', 'proteína'],
    ['fiber', 'fiberMinG', 'fiberMaxG', 'fibra'],
    ['water', 'waterMinMl', 'waterMaxMl', 'água'],
  ] as const;
  for (const [, minField, maxField, label] of ranges) {
    const min = values[minField];
    const max = values[maxField];
    if (max != null && min == null) {
      return { ok: false, field: minField, error: `Informe o mínimo de ${label} antes do máximo` };
    }
    if (min != null && max != null && min > max) {
      return { ok: false, field: maxField, error: `O máximo de ${label} não pode ser menor que o mínimo` };
    }
  }

  if (
    values.energyKcal == null &&
    values.proteinMinG == null &&
    values.fiberMinG == null &&
    values.waterMinMl == null
  ) {
    return { ok: false, field: 'body', error: 'Informe ao menos uma meta' };
  }

  let objectives: GoalObjective[] = [];
  if (body.objectives !== undefined && body.objectives !== null) {
    if (!Array.isArray(body.objectives)) {
      return { ok: false, field: 'objectives', error: 'objectives deve ser uma lista' };
    }
    for (const o of body.objectives) {
      if (typeof o !== 'string' || !(GOAL_OBJECTIVES as readonly string[]).includes(o)) {
        return { ok: false, field: 'objectives', error: `Objetivo inválido: ${String(o)}` };
      }
    }
    objectives = Array.from(new Set(body.objectives as GoalObjective[]));
    if (objectives.length > GOAL_LIMITS.maxObjectives) {
      return { ok: false, field: 'objectives', error: `No máximo ${GOAL_LIMITS.maxObjectives} objetivos` };
    }
  }

  let patientNote: string | null = null;
  if (body.patientNote !== undefined && body.patientNote !== null) {
    if (typeof body.patientNote !== 'string') {
      return { ok: false, field: 'patientNote', error: 'patientNote deve ser texto' };
    }
    const trimmed = body.patientNote.trim();
    if (trimmed.length > GOAL_LIMITS.noteMaxLength) {
      return { ok: false, field: 'patientNote', error: `Observação com no máximo ${GOAL_LIMITS.noteMaxLength} caracteres` };
    }
    patientNote = trimmed.length > 0 ? trimmed : null;
  }

  return {
    ok: true,
    value: {
      energyKcal: values.energyKcal,
      proteinMinG: values.proteinMinG,
      proteinMaxG: values.proteinMaxG,
      fiberMinG: values.fiberMinG,
      fiberMaxG: values.fiberMaxG,
      waterMinMl: values.waterMinMl,
      waterMaxMl: values.waterMaxMl,
      objectives,
      patientNote,
    },
  };
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

function rowToGoals(row: any): NutritionGoals {
  return {
    energyKcal: num(row.energy_kcal),
    proteinMinG: num(row.protein_min_g),
    proteinMaxG: num(row.protein_max_g),
    fiberMinG: num(row.fiber_min_g),
    fiberMaxG: num(row.fiber_max_g),
    waterMinMl: num(row.water_min_ml),
    waterMaxMl: num(row.water_max_ml),
    objectives: (row.objectives ?? []) as GoalObjective[],
    patientNote: row.patient_note ?? null,
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedByName: row.updated_by_name ?? null,
  };
}

const SELECT_GOALS = `
  SELECT g.*, u.name AS updated_by_name
    FROM nutrition_patient_goals g
    LEFT JOIN users u ON u.id = g.updated_by
   WHERE g.patient_id = $1
   LIMIT 1`;

export async function getNutritionGoals(patientId: number): Promise<NutritionGoals | null> {
  const { rows } = await pool.query(SELECT_GOALS, [patientId]);
  return rows[0] ? rowToGoals(rows[0]) : null;
}

/**
 * Upsert por `patient_id` — reenviar o mesmo payload produz o mesmo estado
 * (sem linha duplicada, sem histórico paralelo). Autorização (vínculo +
 * consent) é das rotas; aqui só persiste.
 */
export async function upsertNutritionGoals(
  patientId: number,
  nutriId: number,
  input: NutritionGoalsInput
): Promise<NutritionGoals> {
  await pool.query(
    `INSERT INTO nutrition_patient_goals
       (patient_id, energy_kcal, protein_min_g, protein_max_g, fiber_min_g, fiber_max_g,
        water_min_ml, water_max_ml, objectives, patient_note, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11)
     ON CONFLICT (patient_id) DO UPDATE SET
       energy_kcal   = EXCLUDED.energy_kcal,
       protein_min_g = EXCLUDED.protein_min_g,
       protein_max_g = EXCLUDED.protein_max_g,
       fiber_min_g   = EXCLUDED.fiber_min_g,
       fiber_max_g   = EXCLUDED.fiber_max_g,
       water_min_ml  = EXCLUDED.water_min_ml,
       water_max_ml  = EXCLUDED.water_max_ml,
       objectives    = EXCLUDED.objectives,
       patient_note  = EXCLUDED.patient_note,
       updated_by    = EXCLUDED.updated_by,
       updated_at    = NOW()`,
    [
      patientId,
      input.energyKcal,
      input.proteinMinG,
      input.proteinMaxG,
      input.fiberMinG,
      input.fiberMaxG,
      input.waterMinMl,
      input.waterMaxMl,
      input.objectives,
      input.patientNote,
      nutriId,
    ]
  );
  const goals = await getNutritionGoals(patientId);
  return goals!;
}

/** O recorte que `resolveNutritionTarget` consome (kcal + proteína). */
export interface PrescribedTargetInput {
  energyKcal: number | null;
  proteinMinG: number | null;
  proteinMaxG: number | null;
  /** Para o selo "Definida por …" — o resolvedor ignora. */
  updatedByName: string | null;
}

/** Batch para a carteira do nutri — uma query, nunca N+1. */
export async function getPrescribedTargetInputs(userIds: number[]): Promise<Map<number, PrescribedTargetInput>> {
  const map = new Map<number, PrescribedTargetInput>();
  if (userIds.length === 0) return map;
  const { rows } = await pool.query(
    `SELECT g.patient_id, g.energy_kcal, g.protein_min_g, g.protein_max_g, u.name AS updated_by_name
       FROM nutrition_patient_goals g
       LEFT JOIN users u ON u.id = g.updated_by
      WHERE g.patient_id = ANY($1)`,
    [userIds]
  );
  for (const r of rows) {
    map.set(r.patient_id, {
      energyKcal: num(r.energy_kcal),
      proteinMinG: num(r.protein_min_g),
      proteinMaxG: num(r.protein_max_g),
      updatedByName: r.updated_by_name ?? null,
    });
  }
  return map;
}

export async function getPrescribedTargetInput(userId: number): Promise<PrescribedTargetInput | null> {
  return (await getPrescribedTargetInputs([userId])).get(userId) ?? null;
}
