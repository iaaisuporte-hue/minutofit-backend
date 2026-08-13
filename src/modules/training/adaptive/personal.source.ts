import pool from '../../../config/database';
import type { AdaptableWorkoutDay, AdaptationPolicy, WorkoutSourceProvider } from './types';
import { DEFAULT_POLICY } from './types';
import type { WorkoutPlanItemPayload } from '../../../services/personalWorkoutPlanService';
import { dayKey } from '../../../utils/appDay';
import { computeTodayDayIndex } from '../../../utils/weekPreset';

export class PersonalPrescriptionSource implements WorkoutSourceProvider {
  async loadTodayDay(
    userId: number,
    planId?: number,
    dayIndex?: number,
  ): Promise<AdaptableWorkoutDay | null> {
    // Load the active plan for the student
    let planRow: { id: number; personal_id: number; academy_id: number | null; week_preset: string | null } | null = null;

    if (planId) {
      const { rows } = await pool.query(
        `SELECT p.id, p.personal_id, p.academy_id, p.week_preset
         FROM personal_workout_plans p
         WHERE p.id = $1 AND p.student_id = $2 AND p.abandoned_at IS NULL
         LIMIT 1`,
        [planId, userId],
      );
      planRow = rows[0] ?? null;
    } else {
      const { rows } = await pool.query(
        `SELECT p.id, p.personal_id, p.academy_id, p.week_preset
         FROM personal_workout_plans p
         WHERE p.student_id = $1 AND p.abandoned_at IS NULL
         ORDER BY p.created_at DESC LIMIT 1`,
        [userId],
      );
      planRow = rows[0] ?? null;
    }

    if (!planRow) return null;

    // Determine which day to load
    const targetDayIndex = dayIndex ?? computeTodayDayIndex(planRow.week_preset, dayKey());

    const { rows: dayRows } = await pool.query(
      `SELECT d.id, d.day_index, d.name, d.focus, d.payload_json
       FROM personal_workout_plan_days d
       WHERE d.plan_id = $1 AND d.day_index = $2
       LIMIT 1`,
      [planRow.id, targetDayIndex],
    );

    // Fallback: legacy single-day plan stored in payload_json of the plan itself
    let items: WorkoutPlanItemPayload[] = [];
    let dayName = `Dia ${targetDayIndex}`;
    let dayFocus: string | null = null;

    if (dayRows[0]) {
      items = Array.isArray(dayRows[0].payload_json) ? dayRows[0].payload_json : [];
      dayName = dayRows[0].name ?? dayName;
      dayFocus = dayRows[0].focus ?? null;
    } else {
      const { rows: planPayload } = await pool.query(
        `SELECT payload_json FROM personal_workout_plans WHERE id = $1`,
        [planRow.id],
      );
      items = Array.isArray(planPayload[0]?.payload_json) ? planPayload[0].payload_json : [];
    }

    if (items.length === 0) return null;

    return {
      sourceKind: 'personal_prescription',
      sourceRef: { planId: planRow.id, dayIndex: targetDayIndex },
      responsibleParty: { kind: 'personal', personalId: planRow.personal_id },
      academyId: planRow.academy_id,
      name: dayName,
      focus: dayFocus,
      items,
    };
  }

  async resolvePolicy(day: AdaptableWorkoutDay, userId: number): Promise<AdaptationPolicy> {
    if (day.responsibleParty.kind !== 'personal') {
      return { personalId: 0, studentId: userId, academyId: day.academyId, ...DEFAULT_POLICY };
    }
    const personalId = day.responsibleParty.personalId;

    const { rows } = await pool.query(
      `SELECT * FROM training_adaptation_policy
       WHERE personal_id = $1 AND student_id = $2
       LIMIT 1`,
      [personalId, userId],
    );

    if (!rows[0]) {
      return { personalId, studentId: userId, academyId: day.academyId, ...DEFAULT_POLICY };
    }

    const r = rows[0];
    return {
      personalId: r.personal_id,
      studentId: r.student_id,
      academyId: r.academy_id,
      version: r.version,
      masterEnabled: r.master_enabled,
      allowVolumeReduction: r.allow_volume_reduction,
      allowRestIncrease: r.allow_rest_increase,
      allowIntensityReduction: r.allow_intensity_reduction,
      allowActiveRecoverySubstitution: r.allow_active_recovery_substitution,
      allowMobilitySuggestion: r.allow_mobility_suggestion,
      maxSetReductionPct: r.max_set_reduction_pct,
      maxRestIncreasePct: r.max_rest_increase_pct,
      minIntensityPct: r.min_intensity_pct,
    };
  }
}


