/**
 * Regressões do QA mobile pré-go-live (ago/2026): idade mínima no cadastro e
 * invariantes que as lojas cobram e que não dão para verificar sem I/O.
 *
 * Ver plans/qa_mobile_pre_go_live_2026-08-09_1.md.
 */
jest.mock('../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../lib/redisClient', () => ({ getRedisClient: () => null }));

import fs from 'fs';
import path from 'path';

import {
  MINIMUM_AGE_YEARS,
  ageInYears,
  assertAdultBirthDate,
  isAdult,
  parseBirthDate,
} from '../utils/birthDate';
import { dayKey } from '../utils/appDay';

const readSrc = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8');

/** Raiz do monorepo — dois níveis acima do submódulo do backend. */
const MONOREPO_ROOT = path.join(__dirname, '../../../..');

const readRepo = (rel: string): string =>
  fs.readFileSync(path.join(MONOREPO_ROOT, rel), 'utf8');

/**
 * Os irmãos estão por perto?
 *
 * As invariantes de loja moram no app e no site, não aqui: o backend só é o
 * lugar onde alguém lembrou de testá-las. No monorepo isso funciona; no CI
 * deste repositório, não — o `actions/checkout` traz o backend SOZINHO, e
 * `../../../..` resolve para a raiz do sistema de arquivos. O resultado era um
 * `ENOENT: '/minutofit-web/app/(legal)/excluir-conta/page.tsx'`, e o CI ficou
 * vermelho desde que estes testes entraram.
 *
 * Pular quando os arquivos não existem é a mesma escolha já feita para os
 * testes de banco (`describeWithDb`): quem tem o ambiente completo recebe a
 * garantia, quem não tem continua rodando o resto da suíte.
 *
 * O custo é explícito e precisa ser dito: **estas cinco checagens não rodam no
 * CI do backend**. Elas valem no monorepo — que é onde as três frentes são
 * editadas juntas. Verificá-las em CI exigiria um job que faz checkout dos três
 * repositórios, e esse job pertence à raiz, não a este submódulo.
 */
const HAS_SIBLINGS =
  fs.existsSync(path.join(MONOREPO_ROOT, 'minutofit-app/minutofit-app/src')) &&
  fs.existsSync(path.join(MONOREPO_ROOT, 'minutofit-web/app'));

const describeWithMonorepo: jest.Describe = HAS_SIBLINGS ? describe : describe.skip;

describe('SR-1 · data de nascimento e idade mínima', () => {
  it('aceita data válida e normaliza ISO completo', () => {
    expect(parseBirthDate('1990-05-20')).toBe('1990-05-20');
    expect(parseBirthDate('1990-05-20T00:00:00.000Z')).toBe('1990-05-20');
  });

  it('rejeita data que existe no formato mas não no calendário', () => {
    // O Date do JS transformaria 31/02 em 03/03 silenciosamente.
    expect(parseBirthDate('2000-02-31')).toBeNull();
    expect(parseBirthDate('2000-13-01')).toBeNull();
  });

  it('rejeita lixo, vazio e tipos não-string', () => {
    for (const value of ['', 'ontem', '20/05/1990', null, undefined, 19900520, {}]) {
      expect(parseBirthDate(value)).toBeNull();
    }
  });

  it('rejeita data no futuro', () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(parseBirthDate(`${nextYear}-01-01`)).toBeNull();
  });

  it('conta anos completos — aniversário ainda não feito não vale', () => {
    expect(ageInYears('2000-06-15', '2018-06-14')).toBe(17);
    expect(ageInYears('2000-06-15', '2018-06-15')).toBe(18);
    expect(ageInYears('2000-06-15', '2018-06-16')).toBe(18);
  });

  it('isAdult usa o limite declarado', () => {
    // A data de referência tem que sair do DIA DO ALUNO (`dayKey`), que é o
    // mesmo relógio que `ageInYears` usa por dentro. Construir a partir de
    // `getUTCDate()` fazia o teste comparar 13/ago (UTC) com 12/ago (BRT) e
    // falhar todo dia entre 21h e meia-noite — a janela que `appDay.ts` existe
    // justamente para tratar.
    const [ty, tm, td] = dayKey().split('-').map(Number);
    const iso = (y: number, m: number, d: number) =>
      new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

    const exact = iso(ty - MINIMUM_AGE_YEARS, tm, td);
    expect(isAdult(exact)).toBe(true);

    const oneDayShort = iso(ty - MINIMUM_AGE_YEARS, tm, td + 1);
    expect(isAdult(oneDayShort)).toBe(false);
  });

  it('assertAdultBirthDate distingue data inválida de menor de idade', () => {
    expect(() => assertAdultBirthDate('xx')).toThrow(
      expect.objectContaining({ code: 'INVALID_BIRTH_DATE' }),
    );

    const recent = new Date();
    recent.setUTCFullYear(recent.getUTCFullYear() - 10);
    expect(() => assertAdultBirthDate(recent.toISOString().slice(0, 10))).toThrow(
      expect.objectContaining({ code: 'UNDERAGE' }),
    );

    expect(assertAdultBirthDate('1990-05-20')).toBe('1990-05-20');
  });

  it('os dois cadastros públicos exigem a idade no servidor', () => {
    // O campo no formulário é conveniência; a regra tem que estar aqui.
    const service = readSrc('../services/authService.ts');
    const occurrences = service.split('assertAdultBirthDate(data.birthDate)').length - 1;
    expect(occurrences).toBe(2); // registerUser e registerPersonalUser

    const routes = readSrc('../routes/auth.ts');
    expect(routes.split('birthDate: req.body.birthDate').length - 1).toBe(2);
  });

  it('a data de nascimento é persistida nos dois fluxos', () => {
    const service = readSrc('../services/authService.ts');
    expect(service.split('birth_date').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('o aceite de convite não é um caminho lateral em volta do age gate', () => {
    // Personal e nutri: estas rotas também CRIAM conta. Sem a checagem aqui, a
    // cláusula de idade mínima dos Termos seria falsa — bastava um convite.
    const routes = readSrc('../routes/auth.ts');
    expect(routes.split('assertAdultBirthDate(req.body.birthDate)').length - 1).toBe(2);

    // E a validação tem que preceder a criação do usuário: recusar depois
    // deixaria a conta do menor já gravada.
    const inviteBlock = routes.slice(
      routes.indexOf("router.post('/direct-invite/:token/accept'"),
      routes.indexOf("router.post('/direct-invite-nutri/:token/accept'"),
    );
    // Compara com a CHAMADA, não com a palavra: o bloco cita
    // `findOrCreateUserFromContext` num comentário antes, explicando o gate de
    // limite de alunos.
    expect(inviteBlock.indexOf('assertAdultBirthDate')).toBeLessThan(
      inviteBlock.indexOf('await findOrCreateUserFromContext({'),
    );
  });
});

describeWithMonorepo('SR-2 · política das lojas no app empacotado', () => {
  const appSrc = (rel: string) =>
    readRepo(path.join('minutofit-app/minutofit-app/src', rel));

  it('nenhum checkout externo é alcançável a partir do app nativo', () => {
    // Play Billing / Apple 3.1.1: bem digital consumido no app não pode ter
    // caminho de compra fora do billing da loja. Os dois botões de checkout
    // são os únicos pontos que chamam o Mercado Pago.
    for (const file of [
      'features/personalPlan/UpgradeToProButton.tsx',
      'features/academyPlan/AcademyUpgradeButton.tsx',
    ]) {
      const source = appSrc(file);
      expect(source).toContain('isNativeApp()');
      // O gate precisa vir ANTES do handler que redireciona para o gateway.
      expect(source.indexOf('if (isNativeApp())')).toBeLessThan(
        source.indexOf('window.location.href'),
      );
    }
  });

  it('o service worker não manda a notificação para uma rota inexistente', () => {
    const sw = readRepo('minutofit-app/minutofit-app/public/sw.js');
    expect(sw).not.toContain('/app/ficha-nutri');
    // Ícone de notificação em SVG não renderiza no Android/Chrome.
    expect(sw).not.toMatch(/icon:\s*'[^']*\.svg'/);
  });

  it('o Android declara as permissões que as APIs web precisam', () => {
    const manifest = readRepo(
      'minutofit-app/minutofit-app/android/app/src/main/AndroidManifest.xml',
    );
    for (const permission of [
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.CAMERA',
      'android.permission.POST_NOTIFICATIONS',
    ]) {
      expect(manifest).toContain(permission);
    }
    // Rastreio em segundo plano não é suportado — não DECLARAR a permissão
    // (a checagem é sobre a tag, não sobre a palavra: o manifesto a cita num
    // comentário justamente para explicar por que ela não está ali).
    expect(manifest).not.toMatch(/<uses-permission[^>]*ACCESS_BACKGROUND_LOCATION/);
  });

  it('existe página pública de exclusão de conta (exigência do Play)', () => {
    const page = readRepo('minutofit-web/app/(legal)/excluir-conta/page.tsx');
    expect(page).toContain('excluir-conta');
    const sitemap = readRepo('minutofit-web/app/sitemap.ts');
    expect(sitemap).toContain('/excluir-conta');
  });

  it('o pedido de localização é precedido do aviso in-app', () => {
    const tracker = appSrc('pages/user/ActivityTrackerPage.tsx');
    expect(tracker).toContain('if (!locationAllowed) return;');
    expect(tracker.indexOf('if (!locationAllowed) return;')).toBeLessThan(
      tracker.indexOf('navigator.geolocation.watchPosition'),
    );
  });
});
