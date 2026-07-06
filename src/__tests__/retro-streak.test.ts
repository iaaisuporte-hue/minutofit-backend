/**
 * Unit puro dos helpers de streak do registro retroativo (Spec 024).
 *
 * INVARIANTE central: um registro retroativo NUNCA pode fazer o streak regredir.
 * `computeNextStreak` cobre o avanço da âncora; `computeStreakRunEndingAt` cobre
 * o reparo de lacuna (retro emenda dois trechos de corrida sem mover a âncora).
 * Rodam sem Postgres — são funções puras sobre date_keys 'YYYY-MM-DD'.
 */

import { computeNextStreak, computeStreakRunEndingAt } from '../services/gamificationService';

describe('computeNextStreak', () => {
  it('sem histórico começa em 1', () => {
    expect(computeNextStreak(null, '2026-07-06', 0)).toBe(1);
  });

  it('dia seguinte incrementa', () => {
    expect(computeNextStreak('2026-07-05', '2026-07-06', 4)).toBe(5);
  });

  it('gap de 2+ dias reinicia em 1', () => {
    expect(computeNextStreak('2026-07-03', '2026-07-06', 9)).toBe(1);
  });

  it('mesmo dia (diff 0) reinicia em 1 — caso defensivo', () => {
    expect(computeNextStreak('2026-07-06', '2026-07-06', 4)).toBe(1);
  });

  it('vira de mês corretamente', () => {
    expect(computeNextStreak('2026-06-30', '2026-07-01', 2)).toBe(3);
  });
});

describe('computeStreakRunEndingAt', () => {
  it('conta a corrida consecutiva que termina na âncora', () => {
    const keys = ['2026-07-06', '2026-07-05', '2026-07-04', '2026-07-01'];
    expect(computeStreakRunEndingAt(keys, '2026-07-06')).toBe(3);
  });

  it('retro que emenda a lacuna reconecta as duas corridas', () => {
    // Treinou em 04 e 05 (corrida 2), faltou 06, treinou 07 (streak resetou p/ 1).
    // Retro de 06 preenche a lacuna → corrida terminando em 07 vira 4.
    const keysAntes = ['2026-07-07', '2026-07-05', '2026-07-04'];
    expect(computeStreakRunEndingAt(keysAntes, '2026-07-07')).toBe(1);
    const keysDepois = ['2026-07-07', '2026-07-06', '2026-07-05', '2026-07-04'];
    expect(computeStreakRunEndingAt(keysDepois, '2026-07-07')).toBe(4);
  });

  it('âncora ausente na lista → 0', () => {
    expect(computeStreakRunEndingAt(['2026-07-05', '2026-07-04'], '2026-07-06')).toBe(0);
  });

  it('lista vazia → 0', () => {
    expect(computeStreakRunEndingAt([], '2026-07-06')).toBe(0);
  });

  it('ordem da lista não importa (usa Set)', () => {
    const keys = ['2026-07-04', '2026-07-06', '2026-07-05'];
    expect(computeStreakRunEndingAt(keys, '2026-07-06')).toBe(3);
  });

  it('atravessa virada de mês', () => {
    const keys = ['2026-07-01', '2026-06-30', '2026-06-29'];
    expect(computeStreakRunEndingAt(keys, '2026-07-01')).toBe(3);
  });
});
