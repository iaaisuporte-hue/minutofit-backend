import type { SportConfig, SportKey } from '../../types/sport';

const registry = new Map<SportKey, SportConfig>();

export function registerSport(config: SportConfig): void {
  registry.set(config.key, config);
}

export function getSportConfig(key: SportKey): SportConfig | undefined {
  return registry.get(key);
}

export function getRegisteredSports(): SportConfig[] {
  return Array.from(registry.values());
}

export function isValidSportKey(key: string): boolean {
  return registry.has(key as SportKey);
}
