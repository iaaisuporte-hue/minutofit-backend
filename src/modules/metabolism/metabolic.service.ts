import { computeMetabolism, generateMockHistory } from './metabolic.engine';
import { MetabolicHistory, MetabolicInput, MetabolicOutput } from './metabolic.types';

export async function getMetabolismForUser(userId: string): Promise<MetabolicOutput> {
  // MVP: using mocked input. Signature is async to allow a non-breaking swap to real DB queries.
  // TODO: replace with real data — query users table for date_of_birth (derive age),
  //       activity_level, and workouts/week from gamification/user_workout_logs by userId.
  void userId;

  const input: MetabolicInput = {
    age: 30,
    workoutsPerWeek: 3,
    activityLevel: 'medium',
  };

  return computeMetabolism(input);
}

export async function getMetabolismHistoryForUser(userId: string): Promise<MetabolicHistory> {
  const current = await getMetabolismForUser(userId);
  return generateMockHistory(current.score, 14);
}
