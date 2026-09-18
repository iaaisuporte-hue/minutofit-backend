/**
 * PLAN P1B.1 ("Smart Food Logging" spike) — Intake Interpreter por IA.
 * Unit puro: injeta `callModel`, nunca fala com o provedor real.
 */
import { parseAiIntakeTokens, interpretIntakeTextWithAi } from '../services/ai/intakeInterpreterAi';

describe('parseAiIntakeTokens', () => {
  it('aceita um payload válido e mapeia unit → unitType/unitDimension', () => {
    const raw = JSON.stringify({
      items: [
        { foodQuery: 'ovo frito', quantity: 2, unit: 'unidade' },
        { foodQuery: 'leite', quantity: 200, unit: 'ml' },
        { foodQuery: 'arroz', quantity: 1, unit: 'kg' },
      ],
    });
    const tokens = parseAiIntakeTokens(raw);
    expect(tokens).toHaveLength(3);
    expect(tokens![0]).toMatchObject({ foodQuery: 'ovo frito', quantity: 2, unitType: 'measure', measureName: 'unidade' });
    expect(tokens![1]).toMatchObject({ foodQuery: 'leite', quantity: 200, unitType: 'ml', unitDimension: 'volume' });
    // kg converte para a base única de massa (grama) — mesma regra do parser determinístico.
    expect(tokens![2]).toMatchObject({ foodQuery: 'arroz', quantity: 1000, unitType: 'grams' });
  });

  it('devolve [] quando a IA explicitamente não interpretou nada (não é erro)', () => {
    expect(parseAiIntakeTokens('{"items":[]}')).toEqual([]);
  });

  it('rejeita o payload inteiro se qualquer item tiver campo nutricional (a IA NUNCA calcula macro)', () => {
    const raw = JSON.stringify({ items: [{ foodQuery: 'whey', quantity: 30, unit: 'g', energyKcal: 120 }] });
    // energyKcal extra não é um erro de schema per se (campo desconhecido é
    // ignorado), mas o contrato de uso nunca lê nem persiste esse valor —
    // resolveTokenForPreview sempre recalcula a partir do catálogo/histórico.
    const tokens = parseAiIntakeTokens(raw);
    expect(tokens![0]).not.toHaveProperty('energyKcal');
  });

  it('rejeita unit fora do enum permitido', () => {
    const raw = JSON.stringify({ items: [{ foodQuery: 'whey', quantity: 30, unit: 'oz' }] });
    expect(parseAiIntakeTokens(raw)).toBeNull();
  });

  it('rejeita quantity não positiva ou absurda', () => {
    expect(parseAiIntakeTokens(JSON.stringify({ items: [{ foodQuery: 'arroz', quantity: 0, unit: 'g' }] }))).toBeNull();
    expect(parseAiIntakeTokens(JSON.stringify({ items: [{ foodQuery: 'arroz', quantity: 99999, unit: 'g' }] }))).toBeNull();
  });

  it('rejeita foodQuery vazio ou longo demais', () => {
    expect(parseAiIntakeTokens(JSON.stringify({ items: [{ foodQuery: '', quantity: 1, unit: 'g' }] }))).toBeNull();
    expect(parseAiIntakeTokens(JSON.stringify({ items: [{ foodQuery: 'x'.repeat(61), quantity: 1, unit: 'g' }] }))).toBeNull();
  });

  it('rejeita mais de 12 itens (proteção contra payload gigante)', () => {
    const items = Array.from({ length: 13 }, () => ({ foodQuery: 'arroz', quantity: 1, unit: 'g' }));
    expect(parseAiIntakeTokens(JSON.stringify({ items }))).toBeNull();
  });

  it('JSON malformado ou sem items[] devolve null, nunca lança', () => {
    expect(parseAiIntakeTokens('não é json')).toBeNull();
    expect(parseAiIntakeTokens('{"foo":"bar"}')).toBeNull();
  });

  it('aceita cerca de código (```json ... ```) — o modelo às vezes embrulha mesmo instruído a não fazer', () => {
    const raw = '```json\n{"items":[{"foodQuery":"banana","quantity":1,"unit":"unidade"}]}\n```';
    const tokens = parseAiIntakeTokens(raw);
    expect(tokens).toHaveLength(1);
  });
});

describe('interpretIntakeTextWithAi', () => {
  it('devolve os tokens quando o modelo (injetado) responde um payload válido', async () => {
    const callModel = async () => JSON.stringify({ items: [{ foodQuery: 'banana prata', quantity: 1, unit: 'unidade' }] });
    const tokens = await interpretIntakeTextWithAi('uma banana prata', 1, { callModel });
    expect(tokens).toEqual([
      expect.objectContaining({ foodQuery: 'banana prata', quantity: 1 }),
    ]);
  });

  it('devolve null (nunca lança) quando o modelo injetado falha', async () => {
    const callModel = async () => { throw new Error('provider down'); };
    const tokens = await interpretIntakeTextWithAi('qualquer coisa', 1, { callModel });
    expect(tokens).toBeNull();
  });

  it('devolve null quando o modelo devolve algo fora do contrato', async () => {
    const callModel = async () => '{"resposta":"não sei"}';
    const tokens = await interpretIntakeTextWithAi('qualquer coisa', 1, { callModel });
    expect(tokens).toBeNull();
  });
});
