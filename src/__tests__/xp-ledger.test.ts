/**
 * Regras do ledger de XP — unitários (Spec 034, Onda C0).
 *
 * A aritmética do teto é o que impede a moeda de inflacionar. Antes da C0 o
 * valor vinha do corpo da requisição; estes testes travam o contrário: valores
 * no servidor, teto por tipo, teto diário, e nenhum caminho negativo.
 */
import {
  XP_DAILY_CAP,
  XP_RULES,
  resolveAwardAmount,
  type XpKind,
} from '../services/xpLedgerService';

describe('valores — decididos no servidor, nunca no cliente', () => {
  it('a tabela cobre os seis tipos e todos pagam positivo', () => {
    const kinds: XpKind[] = [
      'workout_session', 'activity', 'weekly_goal', 'pr', 'challenge_completed', 'milestone',
    ];
    for (const kind of kinds) {
      expect(XP_RULES[kind].amount).toBeGreaterThan(0);
    }
  });

  it('nenhum tipo sozinho paga mais que o teto do dia', () => {
    for (const rule of Object.values(XP_RULES)) {
      expect(rule.amount).toBeLessThanOrEqual(XP_DAILY_CAP);
    }
  });

  it('a tabela é congelada — recalibrar é nova versão, não edição', () => {
    expect(Object.isFrozen(XP_RULES)).toBe(true);
    expect(Object.isFrozen(XP_RULES.workout_session)).toBe(true);
  });
});

describe('resolveAwardAmount — a aritmética do teto', () => {
  it('primeiro treino do dia paga inteiro', () => {
    expect(resolveAwardAmount('workout_session', 0, 0)).toBe(30);
  });

  it('segundo treino do dia paga zero — perDay satura, sem punição', () => {
    // O treino continua registrado; só a moeda não imprime de novo.
    expect(resolveAwardAmount('workout_session', 1, 30)).toBe(0);
  });

  it('recorde paga duas vezes por dia, na terceira satura', () => {
    expect(resolveAwardAmount('pr', 0, 0)).toBe(15);
    expect(resolveAwardAmount('pr', 1, 15)).toBe(15);
    expect(resolveAwardAmount('pr', 2, 30)).toBe(0);
  });

  it('o teto diário corta o excedente em vez de recusar tudo', () => {
    // Dia cheio: 30 + 20 = 50 pagos. Um recorde (15) só cabe pela metade.
    expect(resolveAwardAmount('pr', 0, 50)).toBe(10);
  });

  it('com o teto batido, tudo paga zero', () => {
    for (const kind of Object.keys(XP_RULES) as XpKind[]) {
      expect(resolveAwardAmount(kind, 0, XP_DAILY_CAP)).toBe(0);
    }
  });

  it('nunca devolve negativo, mesmo com total acima do teto', () => {
    // Estado impossível por construção, mas se o dado chegar sujo a resposta
    // é 0 — jamais um débito.
    expect(resolveAwardAmount('milestone', 0, XP_DAILY_CAP + 40)).toBe(0);
  });

  it('tipos sem teto próprio ainda respeitam o teto do dia', () => {
    expect(resolveAwardAmount('challenge_completed', 5, 0)).toBe(50);
  });

  it('evento único na vida paga inteiro ou não paga — nunca pela metade', () => {
    // Marco e desafio são pagos uma vez só, e a chave no ledger é única: pagar
    // 5 dos 10 gravaria a chave e deixaria o marco pago pela metade PARA
    // SEMPRE, porque a repescagem nunca mais o encontraria. Recusar hoje deixa
    // o dia seguinte pagar o valor cheio.
    expect(resolveAwardAmount('milestone', 0, 55)).toBe(0);
    expect(resolveAwardAmount('milestone', 0, 50)).toBe(10);
    expect(resolveAwardAmount('challenge_completed', 0, 55)).toBe(0);
  });

  it('eventos recorrentes seguem cortando o excedente', () => {
    // A regra de tudo-ou-nada vale só para o que acontece uma vez: um recorde
    // parcial não trava nada, porque outros recordes virão.
    expect(resolveAwardAmount('pr', 0, 50)).toBe(10);
  });
});

describe('contrato da rota — o corpo da requisição não carrega XP', () => {
  // O serviço não aceita mais `xp` (o tipo não tem o campo), mas a rota é a
  // porta: se alguém reintroduzir a leitura de `req.body.xp`, o buraco volta
  // sem quebrar tipo nenhum. Ler o fonte é grosseiro e é de propósito — falha
  // no dia em que a linha reaparecer.
  it('routes/gamification.ts não lê req.body.xp', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.join(__dirname, '../routes/gamification.ts'),
      'utf8',
    );
    expect(source).not.toContain('req.body.xp');
  });
});
