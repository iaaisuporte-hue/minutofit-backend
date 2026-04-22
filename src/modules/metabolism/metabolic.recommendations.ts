import type { MetabolicFactor, MetabolicInput, MetabolicOutput, Recommendation } from './metabolic.types';

export function buildRecommendations(
  input: MetabolicInput,
  output: Pick<MetabolicOutput, 'score' | 'status'>,
  factors: MetabolicFactor[],
): Recommendation[] {
  const recs: Recommendation[] = [];
  const factorIds = new Set(factors.map((f) => f.id));

  if (factorIds.has('frequency.zero') || input.workoutsLast7Days < 2) {
    recs.push({
      id: 'rec.add_workout',
      title: 'Adicione 2 treinos esta semana',
      reason: `Você treinou ${input.workoutsLast7Days}x nos últimos 7 dias`,
      impact: '+10 pontos potenciais',
      cta: { label: 'Treinar agora', route: '/app/user/treinos/em-casa' },
      priority: 10,
    });
  }

  if (input.daysSinceLastActivity !== null && input.daysSinceLastActivity > 5) {
    recs.push({
      id: 'rec.resume_activity',
      title: 'Retome o ritmo com uma caminhada',
      reason: `${input.daysSinceLastActivity} dias desde a última atividade`,
      impact: '-10 de penalidade removida ao retomar',
      cta: { label: 'Registrar atividade', route: '/app/user/activities' },
      priority: 9,
    });
  }

  if (input.distinctMuscleGroupsLast14Days < 3) {
    recs.push({
      id: 'rec.variety',
      title: 'Varie os grupos musculares',
      reason: `Apenas ${input.distinctMuscleGroupsLast14Days} grupo${input.distinctMuscleGroupsLast14Days !== 1 ? 's' : ''} treinado${input.distinctMuscleGroupsLast14Days !== 1 ? 's' : ''} em 14 dias`,
      impact: 'Até +8 pontos com 6 grupos distintos',
      cta: { label: 'Ver catálogo', route: '/app/user/treinos' },
      priority: 7,
    });
  }

  if (input.cardioSessionsLast14Days === 0) {
    recs.push({
      id: 'rec.cardio',
      title: 'Inclua 1 sessão de cardio',
      reason: 'Nenhuma sessão de cardio registrada em 14 dias',
      impact: '+6 pontos com 2 sessões na quinzena',
      cta: { label: 'Registrar atividade', route: '/app/user/activities' },
      priority: 6,
    });
  }

  if (input.workoutsLast7Days >= 3 && input.currentStreakDays >= 3 && output.score < 75) {
    recs.push({
      id: 'rec.push_streak',
      title: 'Sua base está sólida — mantenha o ritmo',
      reason: `Sequência de ${input.currentStreakDays} dias e ${input.workoutsLast7Days} treinos na semana`,
      impact: 'Cada dia adicional na sequência vale +0,7 pontos',
      priority: 5,
    });
  }

  if (output.score >= 75) {
    recs.push({
      id: 'rec.maintain',
      title: 'Você está no topo — foque em recuperação',
      reason: `Score ${output.score} — metabolismo em nível alto`,
      impact: 'Sono e recuperação são os próximos diferenciais',
      priority: 4,
    });
  }

  return recs
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 3);
}
