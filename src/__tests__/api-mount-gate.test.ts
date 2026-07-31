/**
 * Regressão: gate de produto em router montado no prefixo `/api` inteiro.
 *
 * `app.use('/api', metabolismRoutes)` monta o router de metabolismo em TODO o
 * `/api`, porque suas rotas são `/me/metabolism*`. Enquanto esse router usava
 * `router.use(authMiddleware, requireProduct('app'))`, o gate rodava em toda
 * requisição a `/api/*` que chegasse até ele — e respondia 403 para tudo que
 * estivesse montado DEPOIS no index.ts.
 *
 * Efeito em produção (31/07/2026): todo personal criado pelo cadastro público
 * (Spec 026) tomava 403 em /api/professional/*, /api/sport/*, /api/training/*
 * e /api/waitlist. O cadastro de personal concede só o produto `personal` —
 * `app` é do aluno, por design. Passou despercebido porque as contas legadas
 * de teste tinham `app` por seed e porque /api/personal é montado ANTES.
 */

import express from 'express';
import request from 'supertest';
import { requireProduct } from '../middleware/productGate';

/** Monta um app com a MESMA topologia do index.ts: catch-all antes, rota depois. */
function buildApp(catchAllUsesRouterLevelGate: boolean) {
  const app = express();

  // Usuário: personal do cadastro público — tem `personal`, NÃO tem `app`.
  app.use((req, _res, next) => {
    (req as any).user = { id: 145, role: 'personal', products: ['personal'] };
    next();
  });

  // Router montado no /api inteiro (equivalente ao metabolismRoutes)
  const catchAll = express.Router();
  if (catchAllUsesRouterLevelGate) {
    catchAll.use(requireProduct('app')); // ← o defeito
  }
  catchAll.get('/me/metabolism', requireProduct('app'), (_r, res) => res.json({ ok: 'metabolism' }));
  app.use('/api', catchAll);

  // Rota do profissional, montada DEPOIS
  const professional = express.Router();
  professional.use(requireProduct('personal'));
  professional.put('/network-profile', (_r, res) => res.json({ ok: 'perfil salvo' }));
  app.use('/api/professional', professional);

  return app;
}

describe('gate de produto em router montado em /api', () => {
  it('reproduz o defeito: gate no router-level derruba rotas montadas depois', async () => {
    const res = await request(buildApp(true)).put('/api/professional/network-profile');
    expect(res.status).toBe(403);
    expect(res.body.productKey).toBe('app');
  });

  it('com gate por rota, o personal alcança /api/professional', async () => {
    const res = await request(buildApp(false)).put('/api/professional/network-profile');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe('perfil salvo');
  });

  it('o gate do metabolismo continua valendo para quem não tem o produto `app`', async () => {
    const res = await request(buildApp(false)).get('/api/me/metabolism');
    expect(res.status).toBe(403);
    expect(res.body.productKey).toBe('app');
  });
});
