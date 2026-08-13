/**
 * Spec 032 — cancelamento do plano Pro pelo painel.
 *
 * O site prometia "cancele pelo próprio painel" e a rota não existia. Além da
 * promessa falsa, o Decreto 11.034/2022 exige que cancelar seja tão simples
 * quanto contratar — e a contratação é self-serve desde a Spec 008.
 */
const query = jest.fn();
const connect = jest.fn();

jest.mock('../config/database', () => ({ __esModule: true, default: { query, connect } }));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.mock('../services/mercadoPagoService', () => ({
  cancelPreapproval: jest.fn(),
  getPreapprovalStatus: jest.fn(),
}));

import { cancelPreapproval } from '../services/mercadoPagoService';
import { cancelPlatformSubscription, getPersonalPlan } from '../services/personalPlanService';

const mpCancel = cancelPreapproval as jest.Mock;

/** Cliente de transação falso: registra os SQLs para inspeção. */
function fakeClient() {
  const sqls: string[] = [];
  return {
    sqls,
    client: {
      query: jest.fn(async (sql: string) => {
        sqls.push(sql);
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
});

describe('SP32-1 · getPersonalPlan honra o período já pago', () => {
  it('cancelada com período em aberto mantém os limites do Pro', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          plan: 'pro',
          status: 'cancelled',
          student_limit: null,
          ai_enabled: true,
          current_period_end: new Date(Date.now() + 10 * DAY),
        },
      ],
      rowCount: 1,
    });

    const plan = await getPersonalPlan(1);
    // Quem pagou o mês inteiro e cancelou no dia 5 não perde os 25 dias restantes.
    expect(plan.plan).toBe('pro');
    expect(plan.status).toBe('cancelled');
    expect(plan.studentLimit).toBeNull();
    expect(plan.aiEnabled).toBe(true);
  });

  it('cancelada com período vencido (além da tolerância) cai para Free', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          plan: 'pro',
          status: 'cancelled',
          student_limit: null,
          ai_enabled: true,
          current_period_end: new Date(Date.now() - 10 * DAY),
        },
      ],
      rowCount: 1,
    });

    const plan = await getPersonalPlan(1);
    expect(plan.plan).toBe('free');
    expect(plan.studentLimit).toBe(3);
    expect(plan.aiEnabled).toBe(false);
  });

  it('cancelada sem período (nunca chegou a pagar) cai para Free', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { plan: 'pro', status: 'cancelled', student_limit: null, ai_enabled: true, current_period_end: null },
      ],
      rowCount: 1,
    });

    expect((await getPersonalPlan(1)).plan).toBe('free');
  });

  it('pending continua tratada como Free (checkout não pago não dá acesso)', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          plan: 'pro',
          status: 'pending',
          student_limit: null,
          ai_enabled: true,
          current_period_end: new Date(Date.now() + 10 * DAY),
        },
      ],
      rowCount: 1,
    });

    expect((await getPersonalPlan(1)).plan).toBe('free');
  });
});

describe('SP32-2 · cancelPlatformSubscription', () => {
  it('cancela no gateway ANTES de tocar o banco', async () => {
    const { client, sqls } = fakeClient();
    query
      .mockResolvedValueOnce({
        rows: [
          {
            plan: 'pro',
            status: 'active',
            mp_preapproval_id: 'preapp-1',
            current_period_end: new Date(Date.now() + 5 * DAY),
          },
        ],
        rowCount: 1,
      })
      // leitura final de getPersonalPlan
      .mockResolvedValueOnce({
        rows: [
          {
            plan: 'pro',
            status: 'cancelled',
            student_limit: null,
            ai_enabled: true,
            current_period_end: new Date(Date.now() + 5 * DAY),
          },
        ],
        rowCount: 1,
      });
    connect.mockResolvedValueOnce(client);

    const result = await cancelPlatformSubscription(7);

    expect(mpCancel).toHaveBeenCalledWith('preapp-1');
    expect(result.status).toBe('cancelled');
    // Marca "não renova" sem apagar a data — é ela que sustenta o acesso restante.
    const update = sqls.find((s) => s.includes('UPDATE personal_platform_subscriptions'));
    expect(update).toContain("status = 'cancelled'");
    expect(update).not.toContain('current_period_end = NULL');
    expect(sqls.some((s) => s.includes('cancel_requested'))).toBe(true);
    expect(sqls).toContain('COMMIT');
  });

  it('falha do gateway não altera o plano local', async () => {
    query.mockResolvedValueOnce({
      rows: [{ plan: 'pro', status: 'active', mp_preapproval_id: 'preapp-2', current_period_end: null }],
      rowCount: 1,
    });
    mpCancel.mockRejectedValueOnce(new Error('MP fora do ar'));

    await expect(cancelPlatformSubscription(7)).rejects.toThrow(
      expect.objectContaining({ code: 'GATEWAY_ERROR' }),
    );
    // Nunca abriu transação: cancelar local com a recorrência viva cobraria por
    // um plano que o usuário não teria mais.
    expect(connect).not.toHaveBeenCalled();
  });

  it('sem assinatura paga devolve NO_ACTIVE_SUBSCRIPTION', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(cancelPlatformSubscription(7)).rejects.toThrow(
      expect.objectContaining({ code: 'NO_ACTIVE_SUBSCRIPTION' }),
    );

    query.mockResolvedValueOnce({
      rows: [{ plan: 'free', status: 'active', mp_preapproval_id: null, current_period_end: null }],
      rowCount: 1,
    });
    await expect(cancelPlatformSubscription(7)).rejects.toThrow(
      expect.objectContaining({ code: 'NO_ACTIVE_SUBSCRIPTION' }),
    );
    expect(mpCancel).not.toHaveBeenCalled();
  });

  it('cancelar duas vezes não chama o gateway de novo', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          plan: 'pro',
          status: 'cancelled',
          mp_preapproval_id: 'preapp-3',
          current_period_end: new Date(Date.now() + 3 * DAY),
        },
      ],
      rowCount: 1,
    });

    await expect(cancelPlatformSubscription(7)).rejects.toThrow(
      expect.objectContaining({ code: 'ALREADY_CANCELLED' }),
    );
    expect(mpCancel).not.toHaveBeenCalled();
  });
});
