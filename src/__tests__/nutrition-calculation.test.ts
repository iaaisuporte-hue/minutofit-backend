import { resolveGrams, calculateNutrition, sumNutrients, type NutrientsPer100g } from '../services/nutritionCalculation';

describe('nutritionCalculation', () => {
  describe('resolveGrams', () => {
    it('unit "grams" retorna a própria quantidade', () => {
      expect(resolveGrams(150, 'grams')).toBe(150);
    });

    it('unit "measure" multiplica quantidade × gramas da medida', () => {
      // SPEC 038 §17: "2 colheres de sopa, 1 colher = 25g" → 50g
      expect(resolveGrams(2, 'measure', 25)).toBe(50);
    });

    it('rejeita quantidade <= 0', () => {
      expect(() => resolveGrams(0, 'grams')).toThrow('quantity_must_be_positive');
      expect(() => resolveGrams(-5, 'grams')).toThrow('quantity_must_be_positive');
    });

    it('rejeita medida sem measureGrams', () => {
      expect(() => resolveGrams(2, 'measure')).toThrow('measure_grams_required');
      expect(() => resolveGrams(2, 'measure', 0)).toThrow('measure_grams_required');
    });
  });

  describe('calculateNutrition', () => {
    const per100g: NutrientsPer100g = {
      energyKcal: 200, proteinG: 20, carbohydrateG: 10, fatG: 8, fiberG: 4, sodiumMg: 50,
    };

    it('escala proporcionalmente à gramagem (SPEC 038 §60)', () => {
      // 100g = 200kcal/P20/C10/G8/F4 → 150g = 300kcal/P30/C15/G12/F6
      const r = calculateNutrition(per100g, 150);
      expect(r).toEqual({ energyKcal: 300, proteinG: 30, carbohydrateG: 15, fatG: 12, fiberG: 6, sodiumMg: 75 });
    });

    it('50g de referência 100g dá exatamente metade', () => {
      const r = calculateNutrition(per100g, 50);
      expect(r).toEqual({ energyKcal: 100, proteinG: 10, carbohydrateG: 5, fatG: 4, fiberG: 2, sodiumMg: 25 });
    });

    it('fibra/sódio null na fonte permanecem null calculados (nunca viram 0)', () => {
      const r = calculateNutrition({ ...per100g, fiberG: null, sodiumMg: null }, 150);
      expect(r.fiberG).toBeNull();
      expect(r.sodiumMg).toBeNull();
    });

    it('rejeita gramas <= 0', () => {
      expect(() => calculateNutrition(per100g, 0)).toThrow('grams_must_be_positive');
    });

    it('medida caseira produz o MESMO resultado que informar a gramagem equivalente manualmente (SPEC 038 §61)', () => {
      const viaMeasure = calculateNutrition(per100g, resolveGrams(2, 'measure', 25));
      const viaGrams = calculateNutrition(per100g, resolveGrams(50, 'grams'));
      expect(viaMeasure).toEqual(viaGrams);
    });
  });

  describe('sumNutrients', () => {
    it('soma múltiplos itens calculados (SPEC 038 §62)', () => {
      const a = calculateNutrition({ energyKcal: 100, proteinG: 5, carbohydrateG: 20, fatG: 2, fiberG: 1, sodiumMg: 10 }, 100);
      const b = calculateNutrition({ energyKcal: 200, proteinG: 30, carbohydrateG: 0, fatG: 10, fiberG: 0, sodiumMg: 400 }, 100);
      const total = sumNutrients([a, b]);
      expect(total.energyKcal).toBe(300);
      expect(total.proteinG).toBe(35);
      expect(total.carbohydrateG).toBe(20);
      expect(total.fatG).toBe(12);
      expect(total.fiberG).toBe(1);
      expect(total.fiberPartial).toBe(false);
    });

    it('marca fiberPartial quando um item tem fibra e outro não (nunca finge que o total é completo)', () => {
      const withFiber = calculateNutrition({ energyKcal: 100, proteinG: 5, carbohydrateG: 20, fatG: 2, fiberG: 3, sodiumMg: null }, 100);
      const withoutFiber = calculateNutrition({ energyKcal: 50, proteinG: 2, carbohydrateG: 10, fatG: 1, fiberG: null, sodiumMg: null }, 100);
      const total = sumNutrients([withFiber, withoutFiber]);
      expect(total.fiberG).toBe(3);
      expect(total.fiberPartial).toBe(true);
    });

    it('fiberG é null quando NENHUM item tinha fibra medida', () => {
      const item = calculateNutrition({ energyKcal: 50, proteinG: 2, carbohydrateG: 10, fatG: 1, fiberG: null, sodiumMg: null }, 100);
      const total = sumNutrients([item, item]);
      expect(total.fiberG).toBeNull();
      expect(total.fiberPartial).toBe(false);
    });

    it('lista vazia soma zero e não marca partial', () => {
      const total = sumNutrients([]);
      expect(total).toEqual({
        energyKcal: 0, proteinG: 0, carbohydrateG: 0, fatG: 0,
        fiberG: null, fiberPartial: false, sodiumMg: null, sodiumPartial: false,
      });
    });
  });
});
