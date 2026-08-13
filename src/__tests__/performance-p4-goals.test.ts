/**
 * Engine de metas — unitários (Spec 033, Onda P4).
 *
 * Testes de FUNÇÃO PURA: nenhum banco, nenhum relógio. O que se protege aqui é
 * a aritmética do progresso e, principalmente, as bordas onde uma divisão
 * descuidada colocaria `NaN` ou `Infinity` dentro de um JSON.
 */
import {
  MAX_ACTIVE_GOALS,
  canTransition,
  computeGoalProgress,
  isGoalAlreadyMet,
  isGoalExpired,
  isMonotonicKind,
  progressTarget,
  progressUnit,
  startOfIsoWeek,
  startOfMonth,
  unitForKind,
  type GoalKind,
} from '../modules/performance/goals.engine';

const carga = (over: Partial<Parameters<typeof computeGoalProgress>[0]> = {}) =>
  computeGoalProgress({
    kind: 'exercise_load',
    baseline: 70,
    target: 100,
    current: null,
    best: null,
    ...over,
  });

describe('progresso — a aritmética do caminho andado', () => {
  it('mede a partir do baseline, não do zero', () => {
    // 85 kg entre 70 e 100 é metade do caminho. Medindo do zero seriam 85%,
    // e a meta pareceria quase pronta sem o aluno ter progredido tanto.
    expect(carga({ best: 85 }).ratio).toBe(0.5);
  });

  it('a meta nasce em zero, não em "quase lá"', () => {
    expect(carga({ best: 70 }).ratio).toBe(0);
  });

  it('atingir o alvo fecha em 1 e zera o que falta', () => {
    const r = carga({ best: 100 });
    expect(r.ratio).toBe(1);
    expect(r.reached).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('passar do alvo não rende barra acima de 100%', () => {
    const r = carga({ best: 130 });
    expect(r.ratio).toBe(1);
    expect(r.displayValue).toBe(130);
  });

  it('diz quanto falta na unidade da meta', () => {
    expect(carga({ best: 82.5 }).remaining).toBe(17.5);
  });
});

describe('bordas que produziriam NaN ou Infinity', () => {
  it('baseline igual ao alvo não divide por zero', () => {
    const r = carga({ baseline: 100, target: 100, best: 90 });
    expect(Number.isFinite(r.ratio!)).toBe(true);
    expect(r.ratio).toBe(0);
  });

  it('alvo abaixo do baseline devolve resposta binária, não negativa', () => {
    const r = carga({ baseline: 100, target: 80, best: 105 });
    expect(r.ratio).toBe(1);
    expect(r.reached).toBe(true);
  });

  it('sem medição alguma, progresso é null — nunca zero disfarçado', () => {
    const r = carga({ current: null, best: null });
    expect(r.ratio).toBeNull();
    expect(r.displayValue).toBeNull();
    expect(r.remaining).toBeNull();
  });

  it('sem baseline, mede do zero e continua finito', () => {
    const r = carga({ baseline: null, best: 40 });
    expect(r.ratio).toBe(0.4);
  });

  it('valores absurdos não escapam como NaN nem Infinity', () => {
    for (const best of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e12]) {
      const r = carga({ best });
      expect(r.ratio === null || (Number.isFinite(r.ratio) && r.ratio >= 0 && r.ratio <= 1)).toBe(true);
      expect(Number.isNaN(r.remaining as number)).toBe(false);
    }
  });

  it('regressão abaixo do baseline mostra zero, não número negativo', () => {
    // Só uma meta cíclica pode cair assim: a monotônica guarda o melhor.
    const r = computeGoalProgress({
      kind: 'weekly_frequency',
      baseline: 3,
      target: 5,
      current: 1,
      best: null,
    });
    expect(r.ratio).toBe(0);
  });
});

describe('monotônicas × cíclicas — a distinção que evita dois absurdos', () => {
  it('meta de carga lê o melhor: treino leve não apaga o pesado', () => {
    const r = carga({ best: 95, current: 60 });
    expect(r.displayValue).toBe(95);
    expect(r.ratio).toBe(0.833);
  });

  it('meta semanal lê o período: segunda-feira é 0 de 4, e está certo', () => {
    const r = computeGoalProgress({
      kind: 'weekly_frequency',
      baseline: 0,
      target: 4,
      current: 0,
      best: 4, // semana passada foi perfeita — e isso não conta para esta
    });
    expect(r.displayValue).toBe(0);
    expect(r.ratio).toBe(0);
    expect(r.reached).toBe(false);
  });

  it('a tabela de monotonicidade não é derivável do nome do tipo', () => {
    expect(isMonotonicKind('streak')).toBe(true);
    expect(isMonotonicKind('weekly_frequency')).toBe(false);
    expect(isMonotonicKind('exercise_load')).toBe(true);
  });
});

describe('meta de dois alvos — "30 kg × 12 reps"', () => {
  it('o progresso corre no eixo das repetições, não no da carga', () => {
    expect(progressTarget('exercise_reps_at_load', 30, 12)).toBe(12);
    expect(progressUnit('exercise_reps_at_load')).toBe('reps');
  });

  it('nos demais tipos o eixo é o próprio alvo', () => {
    expect(progressTarget('exercise_load', 100, null)).toBe(100);
    expect(progressUnit('exercise_load')).toBe('kg');
  });

  it('8 repetições rumo a 12 é dois terços — não 100% por causa da carga', () => {
    const r = computeGoalProgress({
      kind: 'exercise_reps_at_load',
      baseline: 6,
      target: 12,
      current: null,
      best: 8,
    });
    expect(r.reached).toBe(false);
    expect(r.ratio).toBe(0.333);
  });
});

describe('meta que já nasceria cumprida', () => {
  it('é recusada quando o baseline já alcança o alvo', () => {
    expect(isGoalAlreadyMet(105, 100)).toBe(true);
    expect(isGoalAlreadyMet(100, 100)).toBe(true);
  });

  it('é aceita quando ainda há caminho', () => {
    expect(isGoalAlreadyMet(99.5, 100)).toBe(false);
  });

  it('sem baseline nunca é considerada cumprida', () => {
    expect(isGoalAlreadyMet(null, 100)).toBe(false);
  });
});

describe('prazo', () => {
  it('a meta que vence hoje ainda está viva', () => {
    expect(isGoalExpired('2026-08-13', '2026-08-13')).toBe(false);
  });

  it('ontem expirou', () => {
    expect(isGoalExpired('2026-08-12', '2026-08-13')).toBe(true);
  });

  it('amanhã não', () => {
    expect(isGoalExpired('2026-08-14', '2026-08-13')).toBe(false);
  });

  it('sem prazo nunca expira — ausência de prazo não é prazo implícito', () => {
    expect(isGoalExpired(null, '2099-01-01')).toBe(false);
  });

  it('a virada de ano compara como data, não como número', () => {
    expect(isGoalExpired('2025-12-31', '2026-01-01')).toBe(true);
    expect(isGoalExpired('2026-01-01', '2025-12-31')).toBe(false);
  });
});

describe('períodos', () => {
  it('a semana começa na segunda, como o calendário do módulo', () => {
    expect(startOfIsoWeek('2026-08-13')).toBe('2026-08-10'); // quinta → segunda
    expect(startOfIsoWeek('2026-08-10')).toBe('2026-08-10'); // a própria segunda
  });

  it('domingo pertence à semana que começou na segunda anterior', () => {
    expect(startOfIsoWeek('2026-08-16')).toBe('2026-08-10');
  });

  it('a semana atravessa a virada de mês sem se partir', () => {
    expect(startOfIsoWeek('2026-09-01')).toBe('2026-08-31');
  });

  it('o mês é de calendário, não uma janela de 30 dias', () => {
    expect(startOfMonth('2026-08-13')).toBe('2026-08-01');
  });
});

describe('estados', () => {
  it('meta concluída não volta a ativa porque a performance caiu', () => {
    expect(canTransition('achieved', 'active')).toBe(false);
  });

  it('meta abandonada não ressuscita sozinha', () => {
    expect(canTransition('abandoned', 'active')).toBe(false);
    expect(canTransition('abandoned', 'achieved')).toBe(false);
  });

  it('de ativa se sai para os três desfechos', () => {
    expect(canTransition('active', 'achieved')).toBe(true);
    expect(canTransition('active', 'abandoned')).toBe(true);
    expect(canTransition('active', 'expired')).toBe(true);
  });
});

describe('unidades e limites', () => {
  it('a unidade é do tipo, não uma escolha do cliente', () => {
    const esperado: Record<GoalKind, string> = {
      exercise_load: 'kg',
      exercise_e1rm: 'kg',
      exercise_reps_at_load: 'kg',
      weekly_frequency: 'sessions',
      monthly_frequency: 'sessions',
      streak: 'days',
    };
    for (const [kind, unit] of Object.entries(esperado)) {
      expect(unitForKind(kind as GoalKind)).toBe(unit);
    }
  });

  it('o limite de metas ativas é o da spec', () => {
    expect(MAX_ACTIVE_GOALS).toBe(5);
  });
});
