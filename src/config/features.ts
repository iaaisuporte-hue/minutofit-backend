/**
 * Flags de produto resolvidas por ambiente (infra), distintas das feature flags
 * de plano no banco (`plan_features`).
 */

/**
 * Cobrança aluno↔profissional PELA plataforma (take-rate / MP repasse).
 *
 * **Congelado na V1 por decisão consciente** (ver CLAUDE.md): a plataforma cobra
 * só o personal (SaaS Free/Pro); dinheiro personal↔aluno fica FORA da plataforma
 * ("não tocamos no seu PIX"). O código de billing existe, mas os fluxos que
 * MOVEM dinheiro (checkout de assinatura do aluno, criação de planos/ofertas com
 * preço) ficam atrás deste gate — sem ele, a plataforma estaria intermediando
 * serviço profissional sem os termos jurídicos de marketplace.
 *
 * Default = desligado. Reativar exige decisão explícita: `STUDENT_BILLING_ENABLED=true`.
 */
export const STUDENT_BILLING_ENABLED = process.env.STUDENT_BILLING_ENABLED === 'true';
