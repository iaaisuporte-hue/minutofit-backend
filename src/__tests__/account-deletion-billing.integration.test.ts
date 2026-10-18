/**
 * Encerramento de conta com cobrança recorrente e dono de academia (Spec 040) — banco REAL,
 * rotas REAIS, Mercado Pago SIMULADO.
 *
 * `axios` é trocado por um gateway fake em memória (recorrência → status) com falhas
 * programáveis. Nenhuma chamada ao Mercado Pago de verdade, nenhum token real: o que se afirma
 * aqui é o COMPORTAMENTO — ordem (cancela antes de excluir), idempotência, pendência
 * reconciliável e as travas do servidor, que a UI sozinha não garante.
 *
 * Rodar: TEST_DATABASE_URL=postgresql://corefit:corefit@localhost:5433/<banco_de_teste>
 */
import crypto from 'crypto';
import type { Client } from 'pg';

import {
  acquireSuiteLock,
  cleanFixtures,
  connect,
  createUser,
  describeWithDb,
  finishSuite,
  hasTestDb,
} from './helpers/integrationDb';

if (hasTestDb) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// ── Gateway fake ─────────────────────────────────────────────────────────────

type Falha = 'timeout' | 'server' | 'auth' | null;
const gateway = {
  /** preapproval id → status no "Mercado Pago". */
  status: new Map<string, string>(),
  falha: null as Falha,
  gets: [] as string[],
  puts: [] as string[],
  /** Rodado dentro do PUT: prova a ORDEM (a conta ainda existia quando o cancelamento saiu). */
  aoCancelar: null as null | ((id: string) => Promise<void>),
};

const erroDeRede = (falha: Exclude<Falha, null>) =>
  falha === 'timeout'
    ? Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' })
    : Object.assign(new Error('falha'), { response: { status: falha === 'server' ? 503 : 401 } });

const idDoUrl = (url: string) => decodeURIComponent(url.split('/preapproval/')[1]);

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: async (url: string) => {
      const id = idDoUrl(url);
      gateway.gets.push(id);
      if (gateway.falha) throw erroDeRede(gateway.falha);
      const status = gateway.status.get(id);
      if (!status) throw Object.assign(new Error('nf'), { response: { status: 404 } });
      return { status: 200, data: { status } };
    },
    put: async (url: string) => {
      const id = idDoUrl(url);
      gateway.puts.push(id);
      if (gateway.falha) throw erroDeRede(gateway.falha);
      if (gateway.aoCancelar) await gateway.aoCancelar(id);
      gateway.status.set(id, 'cancelled');
      return { status: 200, data: { status: 'cancelled' } };
    },
    post: async () => ({ status: 200, data: {} }),
  },
}));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));
jest.setTimeout(180_000);

const TAG = 'itest-adbill';
const SEGREDO = 'segredo-de-teste-do-webhook';

describeWithDb('Spec 040 · encerramento de conta × cobrança recorrente', () => {
  let c: Client;
  let svc: typeof import('../services/accountDeletionService');
  let billing: typeof import('../services/accountDeletionBilling');
  let app: import('express').Express;
  let bearer: (id: number, role: string, produto: string) => string;

  const userIds: number[] = [];
  const academyIds: number[] = [];
  let seq = 0;
  const novoRef = () => `mp-${TAG}-${Date.now()}-${(seq += 1)}`;

  beforeAll(async () => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = 'token-falso-de-teste';
    process.env.MERCADOPAGO_WEBHOOK_SECRET = SEGREDO;
    c = await connect();
    await acquireSuiteLock(c);
    await cleanFixtures(c, TAG);

    svc = await import('../services/accountDeletionService');
    billing = await import('../services/accountDeletionBilling');
    const express = (await import('express')).default;
    const { generateAccessToken } = await import('../utils/jwt');
    const userRoutes = (await import('../routes/user')).default;
    const webhookRoutes = (await import('../routes/webhooks')).default;
    app = express();
    app.use('/api/webhooks', express.json(), webhookRoutes);
    app.use(express.json());
    app.use('/api/user', userRoutes);
    bearer = (id, role, produto) =>
      generateAccessToken({ id, email: `${id}@test.local`, role: role as 'user', profileCompleted: true, products: [produto] } as never);
  });

  afterAll(async () => {
    await finishSuite(c, async () => {
      await cleanFixtures(c, TAG);
      if (academyIds.length) await c.query(`DELETE FROM academies WHERE id = ANY($1)`, [academyIds]);
      if (userIds.length) {
        await c.query(`DELETE FROM account_deletion_requests WHERE user_id = ANY($1)`, [userIds]);
        await c.query(`DELETE FROM account_deletions WHERE user_id = ANY($1)`, [userIds]);
      }
    });
    const pool = (await import('../config/database')).default;
    await pool.end();
  });

  beforeEach(() => {
    gateway.status.clear();
    gateway.falha = null;
    gateway.gets.length = 0;
    gateway.puts.length = 0;
    gateway.aoCancelar = null;
  });

  // ── Fixtures ───────────────────────────────────────────────────────────────

  async function usuario(label: string, role: 'user' | 'personal' | 'nutri' = 'user'): Promise<number> {
    const id = await createUser(c, TAG, label);
    // Sem senha local (conta de login social): a rota não exige re-autenticação por senha.
    await c.query(`UPDATE users SET role = $2, password = NULL WHERE id = $1`, [id, role]);
    userIds.push(id);
    return id;
  }
  const existe = async (id: number) => (await c.query(`SELECT 1 FROM users WHERE id = $1`, [id])).rowCount === 1;

  async function assinaturaDoApp(userId: number, ref: string, status = 'active') {
    gateway.status.set(ref, 'authorized');
    await c.query(
      `INSERT INTO user_subscriptions (user_id, tier_id, status, mercado_pago_subscription_id) VALUES ($1, 2, $2, $3)`,
      [userId, status, ref],
    );
  }
  async function planoDoPersonal(personalId: number, ref: string) {
    gateway.status.set(ref, 'authorized');
    await c.query(
      `INSERT INTO personal_platform_subscriptions (personal_id, plan, status, ai_enabled, mp_preapproval_id) VALUES ($1, 'pro', 'active', true, $2)`,
      [personalId, ref],
    );
  }
  async function contratoComProfissional(alunoId: number, proId: number, ref: string, status = 'active') {
    gateway.status.set(ref, 'authorized');
    const o = await c.query(
      `INSERT INTO professional_service_offerings (professional_id, professional_role, title, price_cents, period)
       VALUES ($1, 'personal', 'Consultoria', 9000, 'monthly') RETURNING id`,
      [proId],
    );
    await c.query(
      `INSERT INTO professional_subscriptions (student_id, professional_id, professional_role, offering_id, price_cents_snapshot, period_snapshot, status, mp_preapproval_id)
       VALUES ($1, $2, 'personal', $3, 9000, 'monthly', $4, $5)`,
      [alunoId, proId, o.rows[0].id, status, ref],
    );
  }
  async function academia(slug: string, donoId: number | null, opts: { status?: string } = {}): Promise<{ id: number; roleOwner: number }> {
    const a = await c.query(
      `INSERT INTO academies (slug, legal_name, display_name, status, owner_user_id) VALUES ($1, $1, $1, $2, $3) RETURNING id`,
      [`${TAG}-${slug}-${Date.now()}`, opts.status ?? 'active', donoId],
    );
    const id = a.rows[0].id as number;
    academyIds.push(id);
    const r = await c.query(
      `INSERT INTO academy_roles (academy_id, slug, label) VALUES ($1, 'academy_owner', 'Dono'), ($1, 'academy_reception', 'Recepção') RETURNING id, slug`,
      [id],
    );
    const roleOwner = r.rows.find((x) => x.slug === 'academy_owner').id as number;
    (a as unknown as { roles: Record<string, number> }).roles = Object.fromEntries(r.rows.map((x) => [x.slug, x.id]));
    if (donoId) await c.query(`INSERT INTO academy_users (user_id, academy_id, role_id, status, is_active) VALUES ($1, $2, $3, 'active', TRUE)`, [donoId, id, roleOwner]);
    return { id, roleOwner };
  }
  async function membro(academiaId: number, userId: number, role: 'academy_owner' | 'academy_reception') {
    const r = await c.query(`SELECT id FROM academy_roles WHERE academy_id = $1 AND slug = $2`, [academiaId, role]);
    await c.query(`INSERT INTO academy_users (user_id, academy_id, role_id, status, is_active) VALUES ($1, $2, $3, 'active', TRUE)`, [userId, academiaId, r.rows[0].id]);
  }
  async function planoPagoDaAcademia(academiaId: number, ref: string) {
    gateway.status.set(ref, 'authorized');
    await c.query(
      `INSERT INTO academy_subscriptions (academy_id, plan, status, intelligence_enabled, mp_preapproval_id) VALUES ($1, 'pro', 'active', true, $2)`,
      [academiaId, ref],
    );
  }

  const excluirPelaApi = (id: number, role = 'user', produto = 'app', corpo: object = {}) =>
    import('supertest').then(({ default: request }) =>
      request(app).delete('/api/user/account').set('Authorization', `Bearer ${bearer(id, role, produto)}`).send({ confirmation: 'EXCLUIR', ...corpo }),
    );
  /** Faz chegar a próxima janela de retentativa (o pedido repetido antes disso não gasta tentativa). */
  const vencerJanela = (requestId: number) =>
    c.query(`UPDATE account_deletion_requests SET next_retry_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [requestId]);

  // ── Caminho comum e ordem ──────────────────────────────────────────────────

  it('1. usuário comum sem assinatura → exclusão normal, sem tocar no gateway', async () => {
    const id = await usuario('comum');
    const r = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    expect(r).toMatchObject({ status: 'completed', subscriptionsCancelled: 0, subscriptionsPending: 0 });
    expect(await existe(id)).toBe(false);
    expect(gateway.gets).toEqual([]);
    expect(gateway.puts).toEqual([]);
    const tomb = await c.query(`SELECT subscriptions_cancelled FROM account_deletions WHERE user_id = $1`, [id]);
    expect(tomb.rows[0].subscriptions_cancelled).toBe(0);
  });

  it('2+3. titular com recorrência própria → o cancelamento sai ANTES da exclusão, o gateway confirma, a exclusão prossegue', async () => {
    const id = await usuario('aluno-pagante');
    const ref = novoRef();
    await assinaturaDoApp(id, ref);
    let contaExistiaNoCancelamento: boolean | null = null;
    gateway.aoCancelar = async () => {
      contaExistiaNoCancelamento = await existe(id);
    };

    const r = await svc.deleteUserAccount(id, { requestedBy: 'self' });

    expect(contaExistiaNoCancelamento).toBe(true); // ordem: cancela primeiro, exclui depois
    expect(gateway.puts).toEqual([ref]);
    expect(gateway.status.get(ref)).toBe('cancelled');
    expect(r).toMatchObject({ status: 'completed', subscriptionsCancelled: 1, subscriptionsPending: 0 });
    expect(await existe(id)).toBe(false);

    // A linha financeira sobrevive anonimizada, e a evidência do que foi cancelado também.
    const fin = await c.query(`SELECT user_id, mercado_pago_subscription_id FROM user_subscriptions WHERE mercado_pago_subscription_id = $1`, [ref]);
    expect(fin.rows[0].user_id).toBeNull();
    const canc = await c.query(`SELECT status FROM account_deletion_cancellations WHERE mp_preapproval_id = $1`, [ref]);
    expect(canc.rows[0].status).toBe('cancelled');
    const req = await c.query(`SELECT status FROM account_deletion_requests WHERE id = $1`, [r.requestId]);
    expect(req.rows[0].status).toBe('completed');
    expect((await c.query(`SELECT subscriptions_cancelled FROM account_deletions WHERE user_id = $1`, [id])).rows[0].subscriptions_cancelled).toBe(1);
  });

  it('personal: o plano SaaS dele também é cancelado antes da exclusão', async () => {
    const id = await usuario('personal-pro', 'personal');
    const ref = novoRef();
    await planoDoPersonal(id, ref);
    const r = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    expect(r.status).toBe('completed');
    expect(gateway.status.get(ref)).toBe('cancelled');
  });

  it('aluno que PAGA um profissional: a recorrência é dele e é cancelada', async () => {
    const pro = await usuario('pro-do-aluno', 'personal');
    const aluno = await usuario('aluno-de-pro');
    const ref = novoRef();
    await contratoComProfissional(aluno, pro, ref);

    const r = await svc.deleteUserAccount(aluno, { requestedBy: 'self' });
    expect(r.status).toBe('completed');
    expect(gateway.status.get(ref)).toBe('cancelled');
    expect(await existe(pro)).toBe(true);
  });

  // ── Falha do gateway ───────────────────────────────────────────────────────

  it('4. timeout do gateway → a conta NÃO é excluída, a pendência é gravada e os dados de reconciliação ficam', async () => {
    const id = await usuario('timeout');
    const ref = novoRef();
    await assinaturaDoApp(id, ref);
    gateway.falha = 'timeout';

    const r = await svc.deleteUserAccount(id, { requestedBy: 'self' });

    expect(r).toMatchObject({ status: 'pending_cancellation', subscriptionsPending: 1 });
    expect(await existe(id)).toBe(true);
    // O id da recorrência continua na linha original (nada de CASCADE nem anonimização ainda).
    const sub = await c.query(`SELECT user_id FROM user_subscriptions WHERE mercado_pago_subscription_id = $1`, [ref]);
    expect(sub.rows[0].user_id).toBe(id);
    const req = await c.query(`SELECT status, attempts, next_retry_at, last_error FROM account_deletion_requests WHERE id = $1`, [r.requestId]);
    expect(req.rows[0]).toMatchObject({ status: 'pending_cancellation', attempts: 1, last_error: 'gateway_timeout' });
    expect(req.rows[0].next_retry_at).not.toBeNull();
    // Nunca vaza corpo de resposta no erro persistido.
    expect(JSON.stringify(req.rows[0])).not.toMatch(/token|bearer|payer/i);
  });

  it('5. retentativa pelo cron → conclui, e NÃO duplica o cancelamento já feito', async () => {
    const id = await usuario('retry');
    const ref = novoRef();
    await assinaturaDoApp(id, ref);
    gateway.falha = 'server';
    const pendente = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    expect(pendente.status).toBe('pending_cancellation');

    // O gateway volta. O cron só pega pedidos vencidos: vence o próximo horário.
    gateway.falha = null;
    await c.query(`UPDATE account_deletion_requests SET next_retry_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [pendente.requestId]);
    const relatorio = await svc.processPendingAccountDeletions();
    expect(relatorio).toMatchObject({ due: expect.any(Number), completed: expect.any(Number) });
    expect(await existe(id)).toBe(false);
    expect(gateway.puts.filter((x) => x === ref)).toHaveLength(1);

    // Rodar de novo não faz nada a ninguém.
    const putsAntes = gateway.puts.length;
    await svc.processPendingAccountDeletions();
    expect(gateway.puts.length).toBe(putsAntes);
  });

  it('já cancelada no gateway → estado terminal aceitável, sem segundo cancelamento (idempotência)', async () => {
    const id = await usuario('ja-cancelada');
    const ref = novoRef();
    await assinaturaDoApp(id, ref);
    gateway.status.set(ref, 'cancelled');

    const r = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    expect(r.status).toBe('completed');
    expect(gateway.puts).toEqual([]); // consultou, viu cancelada, não cancelou de novo
    expect((await c.query(`SELECT status FROM account_deletion_cancellations WHERE mp_preapproval_id = $1`, [ref])).rows[0].status).toBe('already_terminal');
  });

  it('recorrência inexistente no gateway (404) → terminal aceitável', async () => {
    const id = await usuario('sem-gateway');
    const ref = novoRef();
    await assinaturaDoApp(id, ref);
    gateway.status.delete(ref);
    expect((await svc.deleteUserAccount(id, { requestedBy: 'self' })).status).toBe('completed');
  });

  it('repetir o pedido do usuário enquanto pendente reaproveita o MESMO pedido (um aberto por usuário)', async () => {
    const id = await usuario('duplo-clique');
    await assinaturaDoApp(id, novoRef());
    gateway.falha = 'server';
    const a = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    const b = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    expect(b.requestId).toBe(a.requestId);
    expect((await c.query(`SELECT COUNT(*)::int AS n FROM account_deletion_requests WHERE user_id = $1`, [id])).rows[0].n).toBe(1);
  });

  it('clique repetido ANTES da próxima janela não chama o gateway nem gasta tentativa (cinco cliques não esgotam as 24h)', async () => {
    const id = await usuario('cliques');
    await assinaturaDoApp(id, novoRef());
    gateway.falha = 'server';
    const a = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    const chamadasAntes = gateway.gets.length;

    for (let i = 0; i < 6; i += 1) await svc.deleteUserAccount(id, { requestedBy: 'self' });

    expect(gateway.gets.length).toBe(chamadasAntes);
    const req = await c.query(`SELECT status, attempts FROM account_deletion_requests WHERE id = $1`, [a.requestId]);
    expect(req.rows[0]).toMatchObject({ status: 'pending_cancellation', attempts: 1 });
  });

  it('12. falha permanente → esgota as tentativas, vira "stalled" com evidência, MANTÉM a conta e é reconciliável pelo admin', async () => {
    const id = await usuario('permanente');
    const ref = novoRef();
    await assinaturaDoApp(id, ref);
    gateway.falha = 'auth';

    let ultimo = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    for (let i = 1; i < billing.MAX_ATTEMPTS; i += 1) {
      await vencerJanela(ultimo.requestId!);
      ultimo = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    }

    expect(ultimo.status).toBe('stalled');
    expect(await existe(id)).toBe(true);
    expect((await c.query(`SELECT 1 FROM user_subscriptions WHERE mercado_pago_subscription_id = $1 AND user_id = $2`, [ref, id])).rowCount).toBe(1);
    const evid = await c.query(`SELECT 1 FROM data_access_audit WHERE subject_user_id = $1 AND event_type = 'account.deletion_stalled'`, [id]);
    expect(evid.rowCount).toBeGreaterThan(0);

    // Visível para quem opera, sem PII.
    const lista = await svc.listDeletionRequests('stalled');
    const meu = lista.find((p) => p.id === ultimo.requestId)!;
    expect(meu.cancellations[0]).toMatchObject({ source: 'user_subscriptions', status: 'pending', lastError: 'gateway_auth_401' });

    // O cron não mexe mais num pedido parado…
    expect((await svc.processPendingAccountDeletions()).due).toBe(0);
    // …a reconciliação manual, sim: o gateway voltou, o admin reexecuta, a conta é encerrada.
    gateway.falha = null;
    const r = await svc.retryDeletionRequest(ultimo.requestId!);
    expect(r).toMatchObject({ status: 'completed' });
    expect(await existe(id)).toBe(false);
    expect(gateway.status.get(ref)).toBe('cancelled');
  });

  it('prazo de 24h vencido numa rodada que falha → "stalled" mesmo antes de esgotar as tentativas', async () => {
    const id = await usuario('prazo');
    await assinaturaDoApp(id, novoRef());
    gateway.falha = 'server';
    const a = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    await c.query(`UPDATE account_deletion_requests SET deadline_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [a.requestId]);
    await vencerJanela(a.requestId!);
    const b = await svc.deleteUserAccount(id, { requestedBy: 'self' });
    expect(b.status).toBe('stalled');
    expect(await existe(id)).toBe(true);
  });

  it('backoff cresce e fica limitado ao ritmo do cron', () => {
    expect(billing.backoffMs(1)).toBe(15 * 60_000);
    expect(billing.backoffMs(2)).toBe(30 * 60_000);
    expect(billing.backoffMs(10)).toBe(6 * 60 * 60_000);
  });

  describe('cliente antigo × novo diante de um encerramento pendente', () => {
    it('SEM `acceptsPending` (apps já publicados tratam todo 2xx como "excluída") → 409 deletion_pending, nunca 2xx', async () => {
      const id = await usuario('legado');
      await assinaturaDoApp(id, novoRef());
      gateway.falha = 'server';
      const r = await excluirPelaApi(id);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ success: false, code: 'deletion_pending', status: 'pending_cancellation' });
      expect(String(r.body.message)).toMatch(/24 horas/);
      expect(await existe(id)).toBe(true);
    });

    it('COM `acceptsPending: true` → 202 com a mensagem e o estado', async () => {
      const id = await usuario('novo-cliente');
      await assinaturaDoApp(id, novoRef());
      gateway.falha = 'server';
      const r = await excluirPelaApi(id, 'user', 'app', { acceptsPending: true });
      expect(r.status).toBe(202);
      expect(r.body).toMatchObject({ success: true, status: 'pending_cancellation', subscriptionsPending: 1 });
      expect(await existe(id)).toBe(true);
    });

    it('conta concluída é 200 para os dois', async () => {
      const id = await usuario('concluida-http');
      expect((await excluirPelaApi(id, 'user', 'app', { acceptsPending: true })).status).toBe(200);
    });
  });

  // ── Dono de academia ───────────────────────────────────────────────────────

  describe('dono de academia (o servidor é a fonte de verdade)', () => {
    it('8+13. dono único → 409 academy_owner_transfer_required por CHAMADA DIRETA à API, e a conta permanece', async () => {
      const dono = await usuario('dono-unico');
      const a = await academia('unica', dono);
      const r = await excluirPelaApi(dono);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ success: false, error: 'academy_owner_transfer_required', code: 'academy_owner_transfer_required' });
      expect(r.body.academies).toEqual([{ id: a.id, displayName: expect.any(String) }]);
      expect(String(r.body.message)).toMatch(/transferid|responsável/i);
      expect(await existe(dono)).toBe(true);
      expect(gateway.puts).toEqual([]);
    });

    it('a trava vale mesmo com a academia suspensa (a UI só via academias ativas)', async () => {
      const dono = await usuario('dono-suspensa');
      await academia('suspensa', dono, { status: 'suspended' });
      expect((await excluirPelaApi(dono)).status).toBe(409);
      expect(await existe(dono)).toBe(true);
    });

    it('dono que também é aluno/personal não escapa pela rota de perfil comum (é a mesma rota)', async () => {
      const dono = await usuario('dono-e-personal', 'personal');
      await academia('dupla-funcao', dono);
      expect((await excluirPelaApi(dono, 'personal', 'personal')).status).toBe(409);
    });

    it('academia encerrada formalmente (cancelled) não segura ninguém', async () => {
      const dono = await usuario('dono-encerrada');
      await academia('encerrada', dono, { status: 'cancelled' });
      expect((await excluirPelaApi(dono)).status).toBe(200);
      expect(await existe(dono)).toBe(false);
    });

    it('9. dono COM sucessor já efetivado (outro dono ativo) e sem cobrança paga → exclusão permitida, academia segue', async () => {
      const dono = await usuario('dono-com-sucessor');
      const sucessor = await usuario('sucessor');
      const a = await academia('com-sucessor', dono);
      await membro(a.id, sucessor, 'academy_owner');

      const r = await excluirPelaApi(dono);
      expect(r.status).toBe(200);
      expect(await existe(dono)).toBe(false);
      expect(await existe(sucessor)).toBe(true);
      const ac = await c.query(`SELECT status, owner_user_id FROM academies WHERE id = $1`, [a.id]);
      expect(ac.rows[0].status).toBe('active'); // a academia NÃO foi encerrada nem apagada
    });

    it('sucessor existe, mas há assinatura paga no nome da academia → 409 academy_billing_handover_required, sem cancelar o Pro de terceiros', async () => {
      const dono = await usuario('dono-paga');
      const sucessor = await usuario('sucessor-paga');
      const a = await academia('paga', dono);
      await membro(a.id, sucessor, 'academy_owner');
      const ref = novoRef();
      await planoPagoDaAcademia(a.id, ref);

      const r = await excluirPelaApi(dono);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('academy_billing_handover_required');
      expect(await existe(dono)).toBe(true);
      expect(gateway.puts).toEqual([]);
      expect(gateway.status.get(ref)).toBe('authorized'); // o Pro da academia continua vivo
    });

    it('dois donos que se excluem um depois do outro: o 1º sai, o 2º (agora único) é barrado — a academia nunca fica órfã', async () => {
      const a = await usuario('co-dono-a');
      const b = await usuario('co-dono-b');
      const ac = await academia('dois-donos', a);
      await membro(ac.id, b, 'academy_owner');

      expect((await excluirPelaApi(a)).status).toBe(200);
      const r = await excluirPelaApi(b);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('academy_owner_transfer_required');
      expect(await existe(b)).toBe(true);
    });

    it('10. staff que NÃO é proprietário exclui normalmente, e a academia não é afetada', async () => {
      const dono = await usuario('dono-intacto');
      const recepcao = await usuario('recepcao');
      const a = await academia('com-recepcao', dono);
      await membro(a.id, recepcao, 'academy_reception');

      const r = await excluirPelaApi(recepcao);
      expect(r.status).toBe(200);
      expect(await existe(recepcao)).toBe(false);
      expect(await existe(dono)).toBe(true);
      expect((await c.query(`SELECT status FROM academies WHERE id = $1`, [a.id])).rows[0].status).toBe('active');
    });
  });

  // ── Contratos de terceiros ────────────────────────────────────────────────

  describe('11. profissional que sai não cancela nem orfana a cobrança do aluno', () => {
    it('com contrato ATIVO de aluno → 409 client_contracts_active; nada é cancelado, nada é apagado em cascata', async () => {
      const pro = await usuario('pro-com-cliente', 'personal');
      const aluno = await usuario('cliente');
      const ref = novoRef();
      await contratoComProfissional(aluno, pro, ref);

      const r = await excluirPelaApi(pro, 'personal', 'personal');
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'client_contracts_active', count: 1 });
      expect(await existe(pro)).toBe(true);
      expect(gateway.puts).toEqual([]);
      expect(gateway.status.get(ref)).toBe('authorized');
      // A linha do contrato, com o id da recorrência, continua lá.
      expect((await c.query(`SELECT 1 FROM professional_subscriptions WHERE mp_preapproval_id = $1`, [ref])).rowCount).toBe(1);
    });

    it('depois de encerrar o contrato pelo fluxo contratual, o profissional exclui — e a recorrência do aluno NÃO é tocada pela exclusão', async () => {
      const pro = await usuario('pro-liberado', 'personal');
      const aluno = await usuario('cliente-liberado');
      const ref = novoRef();
      // Contrato já encerrado pelo fluxo contratual (status cancelled) — o dinheiro dele é assunto desse fluxo.
      await contratoComProfissional(aluno, pro, ref, 'cancelled');

      const r = await svc.deleteUserAccount(pro, { requestedBy: 'self' });
      expect(r.status).toBe('completed');
      expect(gateway.puts).toEqual([]); // a exclusão do profissional não cancelou recorrência de terceiro
      expect(gateway.status.get(ref)).toBe('authorized');
    });
  });

  // ── Webhooks ──────────────────────────────────────────────────────────────

  describe('webhooks do Mercado Pago (zona crítica)', () => {
    const assinar = (dataId: string, requestId: string, tsOverride?: string) => {
      const ts = tsOverride ?? String(Math.floor(Date.now() / 1000));
      const v1 = crypto.createHmac('sha256', SEGREDO).update(`id:${dataId};request-id:${requestId};ts:${ts}`).digest('hex');
      return `ts=${ts},v1=${v1}`;
    };
    const enviar = async (ref: string, personalId: number, requestId: string, status = 'cancelled', sig?: string) => {
      const request = (await import('supertest')).default;
      return request(app)
        .post(`/api/webhooks/mercadopago?data.id=${encodeURIComponent(ref)}`)
        .set('x-request-id', requestId)
        .set('x-signature', sig ?? assinar(ref, requestId))
        .send({ type: 'subscription_preapproval', data: { id: ref, status, external_reference: `platform-sub:${personalId}` } });
    };
    const eventos = async (personalId: number) =>
      (await c.query(`SELECT COUNT(*)::int AS n FROM personal_platform_billing_events WHERE personal_id = $1`, [personalId])).rows[0].n as number;

    it('6. webhook DUPLICADO (mesmo x-request-id) → 200 nas duas, um único evento e um único efeito', async () => {
      const pro = await usuario('wh-dup', 'personal');
      const ref = novoRef();
      await planoDoPersonal(pro, ref);
      const rid = `req-${novoRef()}`;

      expect((await enviar(ref, pro, rid)).status).toBe(200);
      expect((await enviar(ref, pro, rid)).status).toBe(200);
      expect(await eventos(pro)).toBe(1);
      expect((await c.query(`SELECT status FROM personal_platform_subscriptions WHERE personal_id = $1`, [pro])).rows[0].status).toBe('cancelled');
    });

    it('7. webhook ATRASADO (chega depois da exclusão) → 200, sem 500 em loop, sem recriar nada', async () => {
      const pro = await usuario('wh-atrasado', 'personal');
      const ref = novoRef();
      await planoDoPersonal(pro, ref);
      expect((await svc.deleteUserAccount(pro, { requestedBy: 'self' })).status).toBe('completed');
      expect(await existe(pro)).toBe(false);

      // O "cancelled" que o MP manda em consequência do NOSSO cancelamento chega agora.
      const r = await enviar(ref, pro, `req-${novoRef()}`);
      expect(r.status).toBe(200);
      expect(await eventos(pro)).toBe(0);
      expect(await existe(pro)).toBe(false);
    });

    it('assinatura inválida, ausente ou fora da janela de tempo → 401 (replay não vale)', async () => {
      const pro = await usuario('wh-assinatura', 'personal');
      const ref = novoRef();
      await planoDoPersonal(pro, ref);
      const request = (await import('supertest')).default;
      const semAssinatura = await request(app).post(`/api/webhooks/mercadopago?data.id=${ref}`).send({ type: 'subscription_preapproval', data: { id: ref, status: 'cancelled', external_reference: `platform-sub:${pro}` } });
      expect(semAssinatura.status).toBe(401);
      expect((await enviar(ref, pro, 'r1', 'cancelled', 'ts=123,v1=deadbeef')).status).toBe(401);
      const antigo = String(Math.floor(Date.now() / 1000) - 60 * 60 * 24);
      expect((await enviar(ref, pro, 'r2', 'cancelled', assinar(ref, 'r2', antigo))).status).toBe(401);
      expect(await eventos(pro)).toBe(0);
    });
  });

  // ── Gateway: não vaza nem inventa ─────────────────────────────────────────

  it('um PUT que "dá certo" mas não devolve status cancelled não é aceito como cancelamento', async () => {
    const { cancelRecurringAtGateway } = await import('../services/recurringCancellation');
    const ref = novoRef();
    gateway.status.set(ref, 'authorized');
    const axios = (await import('axios')).default as unknown as { put: jest.Mock | ((...a: unknown[]) => unknown) };
    const original = axios.put;
    axios.put = async () => ({ status: 200, data: { status: 'authorized' } });
    try {
      await expect(cancelRecurringAtGateway(ref)).rejects.toMatchObject({ kind: 'unverified' });
    } finally {
      axios.put = original;
    }
  });
});
