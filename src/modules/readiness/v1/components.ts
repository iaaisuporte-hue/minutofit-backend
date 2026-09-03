import {
  ALL_MUSCLE_GROUPS, FRESHNESS_HOURS, MUSCLE_LABELS, MUSCLE_RECOVERY,
  PLAUSIBLE, TRAINING_LOAD,
} from './config';
import type {
  Baseline, ComponentResult, MetricPoint, MuscleGroupState, MuscleLoadEntry,
  SleepInput, SubjectiveInput,
} from './types';

/**
 * Componentes do motor de prontidão (SPEC Mobile P3 §6).
 *
 * Cada um é uma função pura que devolve `0–100` **ou `null`**. Nenhum devolve 0
 * por falta de dado: a §38 é explícita — ausência de dado ≠ dado ruim, e um
 * zero silencioso é a forma mais eficiente de mentir num score ponderado.
 *
 * Separados em funções e não num método gigante porque é assim que dá para
 * testar "sono ruim afeta SÓ o componente de sono" (§69/QA-P3-24).
 */

const horas = (ms: number) => ms / 3_600_000;

/** O dado ainda vale? (§40) */
function fresco(measuredAt: string, agora: Date, janelaHoras: number): boolean {
  const t = Date.parse(measuredAt);
  if (!Number.isFinite(t)) return false;
  const idade = horas(agora.getTime() - t);
  // Futuro moderado (relógio dessincronizado) é aceito; passado além da janela não.
  return idade >= -1 && idade <= janelaHoras;
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.1 SleepScore (§12)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sono.
 *
 * Sem duração real, o que existe é o booleano do check-in — e é por isso que o
 * baseline importa tanto aqui: quem dorme mal quase toda noite não deve receber
 * a mesma penalidade que quem dorme bem sempre e teve UMA noite ruim. A
 * segunda é notícia; a primeira é o padrão da pessoa, e puni-la todo dia pelo
 * mesmo fato não informa nada.
 *
 * Um número fixo de horas ("8 h") está explicitamente fora (§12).
 */
export function sleepScore(
  sleep: SleepInput | null,
  baseline: Baseline | null,
  agora: Date,
): ComponentResult {
  if (!sleep) return { key: 'sleep', value: null, absentReason: 'no_data' };
  if (!fresco(sleep.measuredAt, agora, FRESHNESS_HOURS.sleep)) {
    return { key: 'sleep', value: null, absentReason: 'stale' };
  }

  if (sleep.durationHours != null) {
    const h = sleep.durationHours;
    if (h < PLAUSIBLE.sleepHours.min || h > PLAUSIBLE.sleepHours.max) {
      return { key: 'sleep', value: null, absentReason: 'implausible' };
    }
  }

  if (sleep.sleptWell == null) return { key: 'sleep', value: null, absentReason: 'no_data' };

  let base = sleep.sleptWell ? 80 : 35;
  const p = baseline?.sleepGoodRatio ?? null;
  let ajuste = 0;

  if (p != null) {
    if (!sleep.sleptWell && p >= 0.8) ajuste = -10;      // desvio grande do próprio padrão
    else if (!sleep.sleptWell && p <= 0.4) ajuste = +10; // é o padrão dela; não pune duas vezes
    else if (sleep.sleptWell && p <= 0.4) ajuste = +5;   // melhorou em relação a si mesma
  }
  base = clamp(base + ajuste);

  return {
    key: 'sleep',
    value: base,
    detail: { sleptWell: sleep.sleptWell, baselineGoodRatio: p, baselineAdjustment: ajuste },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.2 HrvScore (§13) — sem fonte hoje, e é isso que o teste garante
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HRV, **sempre relativo ao baseline** (§13).
 *
 * Um valor absoluto de HRV não significa nada isoladamente: 45 ms é excelente
 * para uma pessoa e ruim para outra. Interpretar o número solto seria o erro
 * que a §13 nomeia.
 */
export function hrvScore(hrv: MetricPoint | null, baseline: Baseline | null, agora: Date): ComponentResult {
  if (!hrv) return { key: 'hrv', value: null, absentReason: 'no_data' };
  if (hrv.value < PLAUSIBLE.hrvMs.min || hrv.value > PLAUSIBLE.hrvMs.max) {
    return { key: 'hrv', value: null, absentReason: 'implausible', detail: { ignored: hrv.value } };
  }
  if (!fresco(hrv.measuredAt, agora, FRESHNESS_HOURS.hrv)) {
    return { key: 'hrv', value: null, absentReason: 'stale' };
  }
  const b = baseline?.hrvMedian ?? null;
  if (b == null || b <= 0) return { key: 'hrv', value: null, absentReason: 'no_baseline' };

  const r = hrv.value / b;
  const v = r >= 1.10 ? 95 : r >= 1.00 ? 85 : r >= 0.92 ? 70 : r >= 0.85 ? 55 : r >= 0.75 ? 40 : 25;
  return { key: 'hrv', value: v, detail: { ratio: Number(r.toFixed(3)), baseline: b } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.3 RestingHrScore (§14)
// ─────────────────────────────────────────────────────────────────────────────

/** FC de repouso contra o baseline. Nunca diagnostica (§14, §50). */
export function restingHrScore(
  rhr: MetricPoint | null, baseline: Baseline | null, agora: Date,
): ComponentResult {
  if (!rhr) return { key: 'restingHr', value: null, absentReason: 'no_data' };
  if (rhr.value < PLAUSIBLE.restingHrBpm.min || rhr.value > PLAUSIBLE.restingHrBpm.max) {
    return { key: 'restingHr', value: null, absentReason: 'implausible', detail: { ignored: rhr.value } };
  }
  if (!fresco(rhr.measuredAt, agora, FRESHNESS_HOURS.restingHr)) {
    return { key: 'restingHr', value: null, absentReason: 'stale' };
  }
  const b = baseline?.restingHrMedian ?? null;
  if (b == null || b <= 0) return { key: 'restingHr', value: null, absentReason: 'no_baseline' };

  const d = rhr.value - b;
  const v = d <= -3 ? 90 : d <= 1 ? 80 : d <= 4 ? 62 : d <= 7 ? 45 : 30;
  return { key: 'restingHr', value: v, detail: { deltaBpm: Number(d.toFixed(1)), baseline: b } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.4 TrainingLoadScore (§15)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Carga recente contra o próprio padrão.
 *
 * Simples e auditável, como a §15 pede: uma razão entre a carga dos últimos 7
 * dias e a média semanal do baseline. **Sem ACWR** — o modelo esportivo exige
 * uma série longa e limpa que nenhum usuário deste app tem, e aplicá-lo com
 * três semanas de dado seria dar aparência de rigor a um chute.
 */
export function trainingLoadScore(
  load: { last7dLoad: number; consecutiveDays: number } | null,
  baseline: Baseline | null,
): ComponentResult {
  if (!load) return { key: 'trainingLoad', value: null, absentReason: 'no_data' };
  const b = baseline?.weeklyLoadAvg ?? null;
  if (b == null || b <= 0) return { key: 'trainingLoad', value: null, absentReason: 'no_baseline' };

  const razao = load.last7dLoad / b;
  const faixa = TRAINING_LOAD.ratioBands.find((f) => razao <= f.max)!;
  let v = faixa.score;

  const excedente = Math.max(0, load.consecutiveDays - TRAINING_LOAD.consecutiveDaysFree);
  const penalidade = Math.min(
    TRAINING_LOAD.consecutivePenaltyMax,
    excedente * TRAINING_LOAD.consecutivePenaltyPerDay,
  );
  v = clamp(v - penalidade);

  return {
    key: 'trainingLoad',
    value: v,
    detail: { ratio: Number(razao.toFixed(2)), baselineWeekly: b, consecutiveDays: load.consecutiveDays, penalty: penalidade },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.5 MuscleRecovery (§16, §17, §18)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recuperação por grupo muscular — o diferencial para musculação (§16).
 *
 * Decaimento exponencial com meia-vida por intensidade da carga. A §18 pede um
 * modelo simples e proíbe "falsa precisão científica": as meias-vidas de
 * 24/36/48 h são a ordem de grandeza aceita, não constantes medidas, e estão
 * declaradas assim na config.
 *
 * A carga é normalizada pelo PICO DE 28 DIAS DAQUELE GRUPO para aquela pessoa —
 * não por um valor absoluto. Cem quilos de supino significam coisas diferentes
 * para dois atletas, e o modelo compara cada um consigo mesmo.
 */
export function muscleRecovery(
  entries: MuscleLoadEntry[],
  baseline: Baseline | null,
  agora: Date,
): MuscleGroupState[] {
  const porGrupo = new Map<string, MuscleLoadEntry[]>();
  for (const e of entries) {
    const idade = horas(agora.getTime() - Date.parse(e.occurredAt));
    if (!Number.isFinite(idade) || idade < -1 || idade > MUSCLE_RECOVERY.windowHours) continue;
    const lista = porGrupo.get(e.group);
    if (lista) lista.push(e);
    else porGrupo.set(e.group, [e]);
  }

  const estados: MuscleGroupState[] = [];

  for (const [grupo, lista] of porGrupo) {
    const pico = baseline?.muscleLoadPeak?.[grupo] ?? 0;
    let deficitTotal = 0;
    let comDesconforto = false;

    for (const e of lista) {
      // Sem pico histórico (usuário novo), a própria carga vira a referência —
      // o efeito é máximo no dia e decai; é conservador e não inventa baseline.
      const normalizada = pico > 0 ? Math.min(1, e.load / pico) : 1;

      const meiaVidaBase =
        normalizada < MUSCLE_RECOVERY.loadBands.lightBelow
          ? MUSCLE_RECOVERY.halfLifeHours.light
          : normalizada > MUSCLE_RECOVERY.loadBands.heavyAbove
            ? MUSCLE_RECOVERY.halfLifeHours.heavy
            : MUSCLE_RECOVERY.halfLifeHours.moderate;

      let meiaVida = meiaVidaBase;
      if (e.sessionRpe != null && e.sessionRpe >= MUSCLE_RECOVERY.highRpe) {
        meiaVida *= MUSCLE_RECOVERY.highRpeMultiplier;
      }
      if (e.discomfort) {
        meiaVida *= MUSCLE_RECOVERY.discomfortMultiplier;
        comDesconforto = true;
      }

      const t = Math.max(0, horas(agora.getTime() - Date.parse(e.occurredAt)));
      deficitTotal += normalizada * 100 * Math.pow(2, -t / meiaVida);
    }

    let recuperacao = clamp(100 - deficitTotal);
    if (comDesconforto) {
      recuperacao = Math.min(recuperacao, MUSCLE_RECOVERY.discomfortRecoveryCeiling);
    }

    estados.push({
      group: grupo,
      label: MUSCLE_LABELS[grupo] ?? grupo,
      recovery: Math.round(recuperacao),
      state:
        recuperacao >= MUSCLE_RECOVERY.states.recoveredAtOrAbove
          ? 'recovered'
          : recuperacao >= MUSCLE_RECOVERY.states.partialAtOrAbove
            ? 'partial'
            : 'recovering',
    });
  }

  return estados.sort((a, b) => a.recovery - b.recovery);
}

/**
 * Componente global de recuperação muscular.
 *
 * Ponderado pelos grupos que o treino de HOJE vai usar (§29): estar com as
 * pernas destruídas é irrelevante num dia de peito, e crítico num dia de perna.
 * Sem treino previsto, é a média simples.
 */
export function muscleRecoveryScore(
  estados: MuscleGroupState[],
  gruposDeHoje: string[] | undefined,
): ComponentResult {
  // Grupo sem carga na janela está RECUPERADO (100) — não ausente. Quem treinou
  // perna tem quadríceps a 0% e peito, costas e ombros intactos, e a média
  // precisa refletir o corpo inteiro.
  //
  // Sem isto, um treino de perna normal zerava a média global e o Readiness
  // inteiro colapsava para "recuperação" (achado do QA P3): o único componente
  // com dado valia 0, e 0 dividido pelo próprio peso é 0.
  const porGrupo = new Map(estados.map((e) => [e.group, e.recovery]));
  const universo = gruposDeHoje?.length ? gruposDeHoje : ALL_MUSCLE_GROUPS;
  const valores = universo.map((g) => porGrupo.get(g) ?? 100);

  if (valores.length === 0) {
    return { key: 'muscleRecovery', value: 100, detail: { reason: 'nenhum grupo a considerar' } };
  }

  const media = valores.reduce((s, v) => s + v, 0) / valores.length;
  return {
    key: 'muscleRecovery',
    value: Math.round(media),
    detail: {
      consideredGroups: [...universo],
      loadedGroups: estados.map((e) => e.group),
      weightedByPlan: !!gruposDeHoje?.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.6 SubjectiveScore (§19)
// ─────────────────────────────────────────────────────────────────────────────

const ENERGIA = { very_high: 95, high: 85, normal: 72, low: 48, very_low: 30 };
const SONO = { excellent: 92, good: 80, fair: 58, poor: 35 };
const DOR = { none: 90, light: 72, moderate: 48, high: 25 };
const ESTRESSE = { low: 88, moderate: 68, high: 42 };

/** Percepção do dia. Média das respostas PRESENTES — não responder não penaliza. */
export function subjectiveScore(s: SubjectiveInput | null, agora: Date, hoje: string): ComponentResult {
  if (!s) return { key: 'subjective', value: null, absentReason: 'no_data' };

  // O check-in vale para o DIA do aluno (§40): o de ontem não descreve hoje.
  const dia = s.measuredAt.slice(0, 10);
  if (dia !== hoje) return { key: 'subjective', value: null, absentReason: 'stale' };
  void agora;

  const valores: number[] = [];
  if (s.energy) valores.push(ENERGIA[s.energy]);
  if (s.sleepQuality) valores.push(SONO[s.sleepQuality]);
  if (s.soreness) valores.push(DOR[s.soreness]);
  if (s.stress) valores.push(ESTRESSE[s.stress]);

  if (valores.length === 0) return { key: 'subjective', value: null, absentReason: 'no_data' };

  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  return {
    key: 'subjective',
    value: Math.round(media),
    detail: { answered: valores.length, energy: s.energy, sleep: s.sleepQuality, soreness: s.soreness, stress: s.stress },
  };
}
