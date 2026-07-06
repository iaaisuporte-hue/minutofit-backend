/**
 * Guards de regressão do registro retroativo (Spec 024) — invariantes estáticas
 * sobre o source (CI roda jest sem Postgres). Se alguém remover essas garantias,
 * o retroativo volta a distorcer streak/aderência ou vaza como registro ao vivo.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('regressão — registro retroativo grava a natureza e a data real', () => {
  const svc = read('services/workoutSessionService.ts');

  it('INSERT do cabeçalho grava performed_at, is_retroactive e confirmation_accepted', () => {
    expect(svc).toMatch(/INSERT INTO workout_sessions[\s\S]*performed_at[\s\S]*is_retroactive[\s\S]*confirmation_accepted/);
  });

  it('retro stampa source user_retroactive (não confia no cliente)', () => {
    expect(svc).toMatch(/isRetroactive\s*\?\s*'user_retroactive'/);
  });

  it('readiness/adaptação são pulados quando retroativo', () => {
    expect(svc).toMatch(/if\s*\(\s*!isRetroactive\s*\)/);
  });

  it('D-2/D-3 grava aderência sem check-in (streak/XP intactos)', () => {
    // Ramo else do diffDays<=1: insere user_workout_logs com completed_at real,
    // sem chamar applyGamificationCheckinTx.
    expect(svc).toMatch(/diffDays\s*<=\s*1/);
    expect(svc).toMatch(/INSERT INTO user_workout_logs[\s\S]*completed_at/);
  });

  it('listSessions e getStudentExecutionSummary expõem performed_at/is_retroactive', () => {
    expect(svc).toMatch(/performed_at,\s*is_retroactive/);
    expect(svc).toMatch(/ORDER BY performed_at DESC/);
  });
});

describe('regressão — streak nunca regride a âncora no retroativo', () => {
  const gam = read('services/gamificationService.ts');

  it('ramo de retro no passado (dateKey < previousDateKey) NÃO atualiza last_checkin_date', () => {
    const idx = gam.indexOf('dateKey < previousDateKey');
    expect(idx).toBeGreaterThan(-1);
    // A janela do branch vai até o `} else {` do fluxo normal.
    const branch = gam.slice(idx, gam.indexOf('} else {', idx));
    expect(branch).toMatch(/computeStreakRunEndingAt/);
    expect(branch).not.toMatch(/last_checkin_date\s*=/);
  });

  it('applyGamificationCheckinTx aceita dateKey e completedAt parametrizados', () => {
    expect(gam).toMatch(/const dateKey = input\.dateKey \?\? todayDateKey\(\)/);
    expect(gam).toMatch(/COALESCE\(\$6::timestamptz, CURRENT_TIMESTAMP\)/);
  });
});

describe('regressão — rota valida janela, honestidade e kill-switch', () => {
  const route = read('routes/training.ts');

  it('gate de feature retro_workout_enabled só no modo retro', () => {
    expect(route).toMatch(/requireFeature\('retro_workout_enabled'\)/);
    expect(route).toMatch(/retroOnly\(/);
  });

  it('cobre os códigos de erro esperados', () => {
    for (const code of ['invalid_performed_at', 'performed_at_in_future', 'retro_window_exceeded', 'honesty_confirmation_required']) {
      expect(route).toContain(code);
    }
  });

  it('rate limit de 3/24h no registro retroativo', () => {
    expect(route).toMatch(/storeKey:\s*'retro_workout'/);
    expect(route).toMatch(/limit:\s*3/);
  });
});
