/**
 * Precedência do alvo semanal — pura, sem banco (hardening pré-C2).
 *
 * A regra é curta e vale dinheiro: ficha vence meta, meta vence nada, e nada
 * NUNCA vira um número inventado.
 */
import { NO_WEEKLY_TARGET, pickWeeklyTarget } from '../modules/performance/consistency.engine';

const ficha = (n: number | null) => ({ weeklyTarget: n, since: '2026-01-01', daysSinceStarted: 60 });
const meta = (n: number | null) => ({ weeklyTarget: n, since: '2026-02-01', daysSinceStarted: 30 });

describe('pickWeeklyTarget', () => {
  it('a prescrição da ficha tem precedência absoluta', () => {
    const r = pickWeeklyTarget(ficha(4), meta(3));
    expect(r.weeklyTarget).toBe(4);
    expect(r.source).toBe('plan');
  });

  it('meta MENOR não substitui prescrição — senão bastava declarar 1x para exibir 100%', () => {
    expect(pickWeeklyTarget(ficha(5), meta(1)).weeklyTarget).toBe(5);
  });

  it('meta MAIOR também não substitui: quem manda é a prescrição', () => {
    expect(pickWeeklyTarget(ficha(3), meta(6)).weeklyTarget).toBe(3);
  });

  it('sem ficha, a meta declarada pelo aluno é o denominador', () => {
    const r = pickWeeklyTarget(ficha(null), meta(3));
    expect(r.weeklyTarget).toBe(3);
    expect(r.source).toBe('goal');
    // A vigência acompanha a fonte escolhida.
    expect(r.since).toBe('2026-02-01');
    expect(r.daysSinceStarted).toBe(30);
  });

  it('sem ficha e sem meta: null, e nenhum padrão inventado', () => {
    const r = pickWeeklyTarget(ficha(null), meta(null));
    expect(r).toEqual(NO_WEEKLY_TARGET);
    // 3x e 4x por semana são os chutes mais tentadores do mercado. Nenhum.
    expect(r.weeklyTarget).not.toBe(3);
    expect(r.weeklyTarget).not.toBe(4);
  });

  it('alvo zero ou negativo não é alvo', () => {
    expect(pickWeeklyTarget(ficha(0), meta(3)).source).toBe('goal');
    expect(pickWeeklyTarget(ficha(-1), meta(0)).weeklyTarget).toBeNull();
  });
});
