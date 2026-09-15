import {
  estimateNutritionTarget,
  splitTargetByMeals,
  resolveNutritionTarget,
  type NutritionObjective,
  type ActivityLevel,
} from '../services/nutritionTarget';

describe('nutritionTarget', () => {
  describe('estimateNutritionTarget', () => {
    const objectives: NutritionObjective[] = ['weight_loss', 'maintenance', 'muscle_gain'];
    const activities: ActivityLevel[] = ['low', 'moderate', 'high'];

    for (const objective of objectives) {
      for (const activity of activities) {
        it(`70kg / ${objective} / ${activity} — kcal dentro do piso/teto e macros não-negativos`, () => {
          const target = estimateNutritionTarget({ weightKg: 70, objective, activity, mealsPerDay: 4 });
          expect(target.energyKcal).toBeGreaterThanOrEqual(1200);
          expect(target.energyKcal).toBeLessThanOrEqual(4500);
          expect(target.proteinG).toBeGreaterThan(0);
          expect(target.carbohydrateG).toBeGreaterThanOrEqual(0);
          expect(target.fatG).toBeGreaterThan(0);
          expect(target.formulaVersion).toBe(1);
        });
      }
    }

    it('aplica o piso de 1200 kcal para peso muito baixo em emagrecimento', () => {
      const target = estimateNutritionTarget({ weightKg: 40, objective: 'weight_loss', activity: 'low', mealsPerDay: 3 });
      expect(target.energyKcal).toBe(1200);
    });

    it('aplica o teto de 4500 kcal para peso muito alto em ganho + atividade alta', () => {
      const target = estimateNutritionTarget({ weightKg: 150, objective: 'muscle_gain', activity: 'high', mealsPerDay: 5 });
      expect(target.energyKcal).toBe(4500);
    });

    it('carboidrato nunca fica negativo mesmo no extremo (peso baixo + ganho)', () => {
      const target = estimateNutritionTarget({ weightKg: 45, objective: 'muscle_gain', activity: 'high', mealsPerDay: 4 });
      expect(target.carbohydrateG).toBeGreaterThanOrEqual(0);
    });

    it('rejeita peso <= 0', () => {
      expect(() => estimateNutritionTarget({ weightKg: 0, objective: 'maintenance', activity: 'moderate', mealsPerDay: 4 }))
        .toThrow('weight_kg_required');
    });

    it('rejeita mealsPerDay fora de 3..6', () => {
      expect(() => estimateNutritionTarget({ weightKg: 70, objective: 'maintenance', activity: 'moderate', mealsPerDay: 2 }))
        .toThrow('meals_per_day_out_of_range');
      expect(() => estimateNutritionTarget({ weightKg: 70, objective: 'maintenance', activity: 'moderate', mealsPerDay: 7 }))
        .toThrow('meals_per_day_out_of_range');
    });

    it('gordura respeita o piso de 20% das kcal mesmo com peso baixo', () => {
      const target = estimateNutritionTarget({ weightKg: 50, objective: 'weight_loss', activity: 'low', mealsPerDay: 3 });
      const fatKcalShare = (target.fatG * 9) / target.energyKcal;
      expect(fatKcalShare).toBeGreaterThanOrEqual(0.199);
    });

    it('devolve a divisão por refeições já embutida (meals.length === mealsPerDay)', () => {
      const target = estimateNutritionTarget({ weightKg: 70, objective: 'maintenance', activity: 'moderate', mealsPerDay: 5 });
      expect(target.meals).toHaveLength(5);
    });
  });

  describe('splitTargetByMeals', () => {
    const totals = { energyKcal: 2100, proteinG: 150, carbohydrateG: 210, fatG: 70 };

    for (const mealsPerDay of [3, 4, 5, 6]) {
      it(`soma de volta ao total exato com ${mealsPerDay} refeições`, () => {
        const meals = splitTargetByMeals(totals, mealsPerDay);
        expect(meals).toHaveLength(mealsPerDay);
        const sum = meals.reduce(
          (acc, m) => ({
            energyKcal: acc.energyKcal + m.energyKcal,
            proteinG: acc.proteinG + m.proteinG,
            carbohydrateG: acc.carbohydrateG + m.carbohydrateG,
            fatG: acc.fatG + m.fatG,
          }),
          { energyKcal: 0, proteinG: 0, carbohydrateG: 0, fatG: 0 }
        );
        expect(Math.round(sum.energyKcal)).toBe(totals.energyKcal);
        expect(Math.round(sum.proteinG)).toBe(totals.proteinG);
        expect(Math.round(sum.carbohydrateG)).toBe(totals.carbohydrateG);
        expect(Math.round(sum.fatG)).toBe(totals.fatG);
      });
    }

    it('rejeita mealsPerDay < 1', () => {
      expect(() => splitTargetByMeals(totals, 0)).toThrow('meals_per_day_out_of_range');
    });
  });

  describe('resolveNutritionTarget', () => {
    it('plano com itens estruturados (energyKcal > 0) vence sobre a estimativa própria', () => {
      const resolved = resolveNutritionTarget({
        planDayTotals: { energyKcal: 1800, proteinG: 140, carbohydrateG: 180, fatG: 60 },
        planMealsCount: 4,
        selfTarget: { energyKcal: 2200, proteinG: 160, carbohydrateG: 220, fatG: 70, mealsPerDay: 5 },
      });
      expect(resolved).toEqual({
        energyKcal: 1800, proteinG: 140, carbohydrateG: 180, fatG: 60,
        mealsPerDay: 4, source: 'plan_items',
      });
    });

    it('plano só-texto (dayTotals.energyKcal === 0) é lido como "sem meta do plano", cai para a estimativa própria', () => {
      const resolved = resolveNutritionTarget({
        planDayTotals: { energyKcal: 0, proteinG: 0, carbohydrateG: 0, fatG: 0 },
        planMealsCount: 3,
        selfTarget: { energyKcal: 2200, proteinG: 160, carbohydrateG: 220, fatG: 70, mealsPerDay: 5 },
      });
      expect(resolved?.source).toBe('self_estimate');
      expect(resolved?.energyKcal).toBe(2200);
    });

    it('sem plano e sem estimativa própria devolve null (nunca meta 0)', () => {
      expect(resolveNutritionTarget({ planDayTotals: null, selfTarget: null })).toBeNull();
    });

    it('sem plano, com estimativa própria — usa a estimativa', () => {
      const resolved = resolveNutritionTarget({
        planDayTotals: null,
        selfTarget: { energyKcal: 2000, proteinG: 150, carbohydrateG: 200, fatG: 65, mealsPerDay: 4 },
      });
      expect(resolved).toEqual({
        energyKcal: 2000, proteinG: 150, carbohydrateG: 200, fatG: 65,
        mealsPerDay: 4, source: 'self_estimate',
      });
    });

    it('plano sem contagem de refeições cai para 3 por padrão', () => {
      const resolved = resolveNutritionTarget({
        planDayTotals: { energyKcal: 1800, proteinG: 140, carbohydrateG: 180, fatG: 60 },
        planMealsCount: null,
      });
      expect(resolved?.mealsPerDay).toBe(3);
    });
  });
});
