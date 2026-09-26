/**
 * PLAN CANONICAL_FOOD_MODEL_SPIKE.md §6-§9 — Canonical Food Resolver.
 *
 * `CanonicalFood` é a identidade de DOMÍNIO do alimento ("peito de frango,
 * grelhado") — computada por requisição a partir da linha de composição já
 * escolhida pelo Food Resolver (`nutritionFoodMatcher.ts`), NUNCA persistida.
 * É diferente da identidade do REGISTRO de composição (`nutrition_foods.id`,
 * `foodId`): duas linhas de fontes diferentes (TACO/USDA) podem apontar para
 * o MESMO `CanonicalFood` — `foodId` é qual dado nutricional foi escolhido
 * para representá-lo agora, não o conceito do alimento em si (§8).
 *
 * Sem tabela nova, sem migration — função pura, mesmo espírito de
 * `quantity`/`unitLabel` em `nutritionIntakeService.ts` (computados,
 * exibição apenas, nunca a base de cálculo).
 */
import { normalizeFoodText, PREPARATION_LEMMAS } from './nutritionFoodMatcher';

export interface CanonicalFood {
  baseFood: string;
  variant: string | null;
  preparation: string | null;
}

/**
 * Mapa curado de nomes naturais — só os alimentos de maior tráfego (corpus
 * auditado no spike, ~30 entradas), nunca as 582+ linhas do catálogo. Chave:
 * `normalizedName` da linha de composição — fonte-agnóstico por design (a
 * mesma chave funciona para uma linha TACO ou uma linha USDA importada, ver
 * §14 do spike), então qualquer fonte que produza esse `normalizedName`
 * ganha o nome natural automaticamente, sem acoplamento a `source`.
 */
const CURATED_BASE_NAMES: Record<string, { baseFood: string; variant?: string }> = {
  'pao trigo frances': { baseFood: 'pão francês' },
  'pao trigo forma integral': { baseFood: 'pão integral' },
  'arroz tipo 1 cozido': { baseFood: 'arroz branco' },
  'arroz integral cozido': { baseFood: 'arroz integral' },
  'feijao carioca cozido': { baseFood: 'feijão carioca' },
  'feijao preto cozido': { baseFood: 'feijão preto' },
  'frango peito sem pele grelhado': { baseFood: 'peito de frango' },
  'frango peito sem pele cozido': { baseFood: 'peito de frango' },
  'frango peito com pele assado': { baseFood: 'peito de frango' },
  'frango peito sem pele cru': { baseFood: 'peito de frango' },
  'ovo de galinha inteiro cru': { baseFood: 'ovo' },
  'ovo de galinha inteiro cozido 10minutos': { baseFood: 'ovo' },
  'ovo de galinha inteiro frito': { baseFood: 'ovo' },
  'banana prata crua': { baseFood: 'banana', variant: 'prata' },
  'banana nanica crua': { baseFood: 'banana', variant: 'nanica' },
  'batata inglesa cozida': { baseFood: 'batata' },
  'batata doce cozida': { baseFood: 'batata doce' },
  'mandioca cozida': { baseFood: 'mandioca' },
  'abacate cru': { baseFood: 'abacate' },
  'aveia flocos crua': { baseFood: 'aveia em flocos' },
  'tomate com semente cru': { baseFood: 'tomate' },
  'cenoura crua': { baseFood: 'cenoura', variant: 'crua' },
  'cenoura cozida': { baseFood: 'cenoura', variant: 'cozida' },
  'brocolis cru': { baseFood: 'brócolis', variant: 'cru' },
  'brocolis cozido': { baseFood: 'brócolis', variant: 'cozido' },
  'cafe infusao 10': { baseFood: 'café' },
  'queijo minas frescal': { baseFood: 'queijo minas', variant: 'frescal' },
  // Importados via USDA FoodData Central (PLAN §14/§16) — mesmo mapa, fonte
  // fica só em `nutrition_foods.source`, nunca no nome exibido ao aluno.
  'leite de vaca integral': { baseFood: 'leite', variant: 'integral' },
  'leite de vaca desnatado': { baseFood: 'leite', variant: 'desnatado' },
  'whey protein isolado': { baseFood: 'whey protein' },
};

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Um segmento do nome da fonte é "puro preparo" quando TODAS as suas
 * palavras SIGNIFICATIVAS batem em `PREPARATION_LEMMAS` — nesses casos ele
 * já aparece como `preparation`, então sai do nome-base para não duplicar.
 * Palavras que começam com dígito ("10minutos", da convenção TACO
 * "cozido/10minutos") são anotação de tempo, não parte do preparo — nunca
 * desqualificam um segmento por si só, mas também não contam como preparo.
 */
function isPreparationSegment(segment: string): boolean {
  const words = normalizeFoodText(segment).split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !/^\d/.test(w));
  return meaningful.length > 0 && meaningful.every((w) => PREPARATION_LEMMAS[w] != null);
}

/**
 * Piso determinístico para as ~550 linhas fora do mapa curado — nunca pior
 * que a string bruta da fonte, nunca exige curadoria de todas as linhas
 * (PLAN §6 passo 2/3). Reordena os segmentos separados por vírgula do nome
 * da fonte, descartando o(s) segmento(s) que já são só preparo (evita
 * duplicar "grelhado" no nome-base quando ele já vai aparecer como legenda).
 */
function genericBaseFood(sourceName: string): string {
  const segments = sourceName.split(',').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return sourceName;
  const [first, ...rest] = segments;
  const qualifiers = rest.filter((seg) => !isPreparationSegment(seg));
  const combined = qualifiers.length > 0 ? `${first}, ${qualifiers.join(', ')}` : first;
  return capitalize(combined.toLowerCase());
}

/**
 * Resolve o `CanonicalFood` de uma linha de composição já escolhida pelo
 * Food Resolver. `preparation` vem do Interpreter (`ParsedIntakeToken`,
 * primeira classe desde §9) — nunca re-derivado aqui a partir do nome da
 * fonte, para não divergir do que o parser já extraiu da fala do usuário.
 */
export function toCanonicalFood(
  food: { name: string; normalizedName: string },
  preparation: string | null,
): CanonicalFood {
  const curated = CURATED_BASE_NAMES[food.normalizedName];
  if (curated) {
    return { baseFood: curated.baseFood, variant: curated.variant ?? null, preparation };
  }
  return { baseFood: genericBaseFood(food.name), variant: null, preparation };
}

/**
 * Preparo derivado do PRÓPRIO nome da linha de composição (nunca do que o
 * usuário disse) — usado só para candidatos ALTERNATIVOS na UI de chips
 * (§10): ali o objetivo é descrever o que cada opção realmente É, não
 * repetir a intenção do usuário em todas elas (o vencedor já usa
 * `token.preparation`, ver `toCanonicalFood` acima e seu chamador).
 */
export function derivePreparationFromSourceName(sourceName: string): string | null {
  const segments = sourceName.split(',').map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    if (isPreparationSegment(seg)) {
      const word = normalizeFoodText(seg).split(' ').filter(Boolean)[0];
      return PREPARATION_LEMMAS[word] ?? null;
    }
  }
  return null;
}
