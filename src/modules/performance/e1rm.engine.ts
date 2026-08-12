/**
 * Estimativa de 1RM (Epley), com guardas.
 *
 * `e1rm = carga × (1 + reps/30)`.
 *
 * Epley em vez de Brzycki porque é mais estável na faixa de 6 a 12 repetições —
 * onde a musculação de academia realmente vive — e porque é simples o bastante
 * para caber numa frase quando o app tiver que explicar o número ao aluno.
 *
 * A guarda de 12 repetições é o ponto: acima disso qualquer fórmula de 1RM
 * extrapola demais e o resultado deixa de ser estimativa para virar número
 * inventado. Preferimos devolver `null` — a série continua contando para
 * tonelagem e para recorde de repetições, só não vira previsão de força máxima.
 *
 * Pura de propósito: é usada pelo backfill (via SQL equivalente na migration
 * 1823), pela detecção online (P2) e pelos testes, sem tocar em banco.
 */
import { E1RM_MAX_REPS, E1RM_MIN_REPS } from './performance.constants';

/**
 * Estimativa de 1RM arredondada a 0,5 kg.
 * Devolve `null` quando os dados não sustentam a estimativa.
 */
export function estimateOneRepMax(loadKg: number | null, reps: number | null): number | null {
  if (loadKg == null || reps == null) return null;
  if (!Number.isFinite(loadKg) || !Number.isFinite(reps)) return null;
  if (loadKg <= 0) return null;
  if (reps < E1RM_MIN_REPS || reps > E1RM_MAX_REPS) return null;
  const raw = loadKg * (1 + reps / 30);
  return Math.round(raw * 2) / 2;
}
