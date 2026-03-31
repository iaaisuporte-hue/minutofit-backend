export type CanonicalPlanName = 'Free' | 'Pro' | 'Premium';

const CANONICAL_BY_ALIAS: Record<string, CanonicalPlanName> = {
  free: 'Free',
  basico: 'Free',
  básico: 'Free',
  basic: 'Free',
  pro: 'Pro',
  silver: 'Pro',
  premium: 'Premium',
  black: 'Premium',
  gold: 'Pro',
};

export function normalizeToCanonicalPlanName(value?: string | null): CanonicalPlanName {
  const raw = String(value || '').trim().toLowerCase();
  return CANONICAL_BY_ALIAS[raw] || 'Free';
}

export function mapCanonicalPlanToLabel(plan: CanonicalPlanName): string {
  if (plan === 'Premium') return 'Premium';
  if (plan === 'Pro') return 'Pro';
  return 'Free';
}

