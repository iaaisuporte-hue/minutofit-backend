/**
 * Guard de regressão — "o score metabólico conta a execução real".
 *
 * INVARIANTE: a frequência de treino em `loadActivityMetrics` deve contar tanto o
 * check-in de gamificação (`user_workout_logs`) quanto a execução real
 * (`workout_sessions`, status completed/partial). Se alguém remover
 * `workout_sessions` dessas queries, sessões reais voltam a virar "dado fantasma"
 * — o aluno treina, registra a sessão, e o score não se move; readiness/adaptação
 * perdem credibilidade (tese MaaS quebra).
 *
 * Teste estático (lê o source): o CI roda jest sem Postgres e o invariante é uma
 * propriedade do SQL. Verificamos no texto que as janelas de 7 e 28 dias unem as
 * duas fontes por dia distinto (sem dupla contagem).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_PATH = join(__dirname, '../modules/metabolism/metabolic.repository.ts');

describe('regressão — score metabólico conta execução (workout_sessions)', () => {
  const src = readFileSync(REPO_PATH, 'utf8');

  it('loadActivityMetrics referencia workout_sessions na frequência', () => {
    const fn = src.slice(src.indexOf('loadActivityMetrics'));
    expect(fn).toMatch(/workout_sessions/);
    // Conta dias distintos via UNION (não UNION ALL) → sem dobrar quando há log e
    // sessão no mesmo dia.
    expect(fn).toMatch(/UNION\b(?!\s+ALL)/);
    // Filtra só sessões efetivamente executadas.
    expect(fn).toMatch(/status\s+IN\s*\(\s*'completed'\s*,\s*'partial'\s*\)/);
  });

  it('mantém user_workout_logs como fonte (não troca, soma)', () => {
    const fn = src.slice(src.indexOf('loadActivityMetrics'));
    expect(fn).toMatch(/user_workout_logs/);
  });
});
