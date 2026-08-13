/**
 * Engine de detecção de recordes — Spec 033, Onda P2.
 *
 * A regra que estes testes protegem: **PR é melhora estrita**. Empate não conta,
 * valor menor não conta, e reprocessar não inventa conquista. Se essa
 * propriedade quebrar, o produto passa a comemorar coisa que não aconteceu — e
 * comemoração que o aluno não reconhece destrói a credibilidade de todas as
 * outras.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));

import {
  bestKey,
  buildPrCandidates,
  detectPrs,
  type CurrentBests,
  type PrSetInput,
} from '../modules/performance/pr.engine';

const EX_A = '11111111-1111-4111-8111-111111111111';
const EX_B = '22222222-2222-4222-8222-222222222222';

function set(
  over: Partial<PrSetInput> & { exerciseId?: string | null } = {},
): PrSetInput {
  return {
    exerciseId: EX_A,
    exerciseName: 'Supino',
    repsDone: 10,
    loadDoneKg: 70,
    status: 'done',
    ...over,
  };
}

/** Atalho: monta o mapa de melhores atuais. */
function bests(entries: [string, string, number][]): CurrentBests {
  const m: CurrentBests = new Map();
  for (const [ex, kind, v] of entries) m.set(bestKey(ex, kind as never), v);
  return m;
}

describe('P2 · candidatos extraídos da sessão', () => {
  it('série pulada não vira candidato', () => {
    const out = buildPrCandidates([set({ status: 'skipped' })]);
    expect(out).toHaveLength(0);
  });

  it('série sem exercício resolvido é ignorada — não há histórico a comparar', () => {
    const out = buildPrCandidates([set({ exerciseId: null })]);
    expect(out).toHaveLength(0);
  });

  it('extrai carga máxima, e1RM e volume de um exercício com carga', () => {
    const out = buildPrCandidates([
      set({ repsDone: 10, loadDoneKg: 70 }),
      set({ repsDone: 8, loadDoneKg: 80 }),
    ]);
    const byKind = Object.fromEntries(out.map((c) => [c.kind, c.value]));
    expect(byKind.max_load).toBe(80);
    // volume = 10×70 + 8×80 = 1340
    expect(byKind.session_volume).toBe(1340);
    // e1RM: 70×(1+10/30)=93.33→93.5 ; 80×(1+8/30)=101.33→101.5 → melhor 101.5
    expect(byKind.best_e1rm).toBe(101.5);
    // com carga não existe recorde de repetições
    expect(byKind.max_reps).toBeUndefined();
  });

  it('peso corporal gera max_reps e nada de carga/volume', () => {
    const out = buildPrCandidates([
      set({ exerciseName: 'Barra fixa', repsDone: 12, loadDoneKg: null }),
      set({ exerciseName: 'Barra fixa', repsDone: 9, loadDoneKg: null }),
    ]);
    const kinds = out.map((c) => c.kind).sort();
    expect(kinds).toEqual(['max_reps']);
    expect(out[0].value).toBe(12);
  });

  it('carga zero é carga informada, não peso corporal', () => {
    // `0` significa "registrei sem peso na barra"; `null` significa "não há
    // carga a registrar". Só o segundo compete em repetições.
    const out = buildPrCandidates([set({ repsDone: 15, loadDoneKg: 0 })]);
    expect(out).toHaveLength(0);
  });

  it('não estima e1RM acima de 12 repetições', () => {
    const out = buildPrCandidates([set({ repsDone: 20, loadDoneKg: 40 })]);
    expect(out.some((c) => c.kind === 'best_e1rm')).toBe(false);
    // mas a série ainda conta como carga e volume
    expect(out.some((c) => c.kind === 'max_load')).toBe(true);
  });

  it('separa exercícios diferentes na mesma sessão', () => {
    const out = buildPrCandidates([
      set({ exerciseId: EX_A, exerciseName: 'Supino', loadDoneKg: 70 }),
      set({ exerciseId: EX_B, exerciseName: 'Agacho', loadDoneKg: 120 }),
    ]);
    const ids = new Set(out.map((c) => c.exerciseId));
    expect(ids).toEqual(new Set([EX_A, EX_B]));
    expect(out.find((c) => c.exerciseId === EX_B && c.kind === 'max_load')?.value).toBe(120);
  });

  it('guarda o contexto da série que fez o recorde', () => {
    const out = buildPrCandidates([
      set({ repsDone: 10, loadDoneKg: 70 }),
      set({ repsDone: 3, loadDoneKg: 100 }),
    ]);
    const maxLoad = out.find((c) => c.kind === 'max_load');
    expect(maxLoad?.loadKg).toBe(100);
    expect(maxLoad?.reps).toBe(3);
  });
});

describe('P2 · detecção contra o histórico', () => {
  const candidates = () => buildPrCandidates([set({ repsDone: 10, loadDoneKg: 80 })]);

  it('primeiro registro é estreia — marca isFirst e não tem anterior', () => {
    const out = detectPrs(candidates(), new Map());
    const maxLoad = out.find((d) => d.kind === 'max_load')!;
    expect(maxLoad.isFirst).toBe(true);
    expect(maxLoad.previousValue).toBeNull();
  });

  it('melhora real vira recorde com o valor anterior registrado', () => {
    const out = detectPrs(candidates(), bests([[EX_A, 'max_load', 75]]));
    const maxLoad = out.find((d) => d.kind === 'max_load')!;
    expect(maxLoad.isFirst).toBe(false);
    expect(maxLoad.value).toBe(80);
    expect(maxLoad.previousValue).toBe(75);
  });

  it('EMPATE não é recorde', () => {
    const out = detectPrs(candidates(), bests([[EX_A, 'max_load', 80]]));
    expect(out.some((d) => d.kind === 'max_load')).toBe(false);
  });

  it('valor MENOR não é recorde nem rebaixa o histórico', () => {
    const out = detectPrs(candidates(), bests([[EX_A, 'max_load', 100]]));
    expect(out.some((d) => d.kind === 'max_load')).toBe(false);
  });

  it('cada categoria é julgada isoladamente', () => {
    // carga empata, mas o volume desta sessão supera o histórico
    const out = detectPrs(
      candidates(),
      bests([[EX_A, 'max_load', 80], [EX_A, 'session_volume', 100]]),
    );
    const kinds = out.map((d) => d.kind);
    expect(kinds).not.toContain('max_load');
    expect(kinds).toContain('session_volume');
  });

  it('histórico de OUTRO exercício não bloqueia o recorde deste', () => {
    const out = detectPrs(candidates(), bests([[EX_B, 'max_load', 500]]));
    expect(out.find((d) => d.kind === 'max_load')?.isFirst).toBe(true);
  });

  it('reprocessar a mesma sessão não gera segundo recorde (retry)', () => {
    // 1ª vez: estreia. O recorde criado passa a ser o histórico.
    const first = detectPrs(candidates(), new Map());
    expect(first.length).toBeGreaterThan(0);

    const afterFirst: CurrentBests = new Map();
    for (const d of first) afterFirst.set(bestKey(d.exerciseId, d.kind), d.value);

    // 2ª vez com os MESMOS dados: nada supera, porque melhora tem que ser estrita.
    const second = detectPrs(candidates(), afterFirst);
    expect(second).toHaveLength(0);
  });

  it('é determinística: mesma entrada, mesma saída', () => {
    const h = bests([[EX_A, 'max_load', 70]]);
    expect(detectPrs(candidates(), h)).toEqual(detectPrs(candidates(), h));
  });

  it('é monotônica: nunca emite valor menor ou igual ao histórico', () => {
    const historico = 90;
    for (const load of [50, 89, 90, 91, 200]) {
      const out = detectPrs(
        buildPrCandidates([set({ repsDone: 5, loadDoneKg: load })]),
        bests([[EX_A, 'max_load', historico]]),
      );
      const maxLoad = out.find((d) => d.kind === 'max_load');
      if (maxLoad) expect(maxLoad.value).toBeGreaterThan(historico);
    }
  });
});

describe('P2 · sequência de sessões 70 → 75 → 75 → 73 → 80', () => {
  it('gera recorde só nas melhoras reais', () => {
    const historico: CurrentBests = new Map();
    const emitidos: number[] = [];

    for (const load of [70, 75, 75, 73, 80]) {
      const out = detectPrs(buildPrCandidates([set({ repsDone: 5, loadDoneKg: load })]), historico);
      const maxLoad = out.find((d) => d.kind === 'max_load');
      if (maxLoad) {
        emitidos.push(maxLoad.value);
        historico.set(bestKey(EX_A, 'max_load'), maxLoad.value);
      }
    }

    // 70 (estreia), 75 (melhora), 80 (melhora). O 75 repetido e o 73 não entram.
    expect(emitidos).toEqual([70, 75, 80]);
  });
});
