/**
 * Backfill de consentimentos para vínculos ativos sem consent.
 *
 * A migration 1790600000000 fez o backfill apenas para os vínculos que já
 * existiam naquele momento. Porém o fluxo de aceite de convite direto
 * (`/auth/direct-invite/:token/accept` e a variante nutri) não chamava
 * `grantConsents`, então alunos/pacientes que entraram por link DEPOIS daquela
 * migration ficaram com o vínculo ativo mas SEM nenhuma linha em
 * `user_data_consents` — o que faz o profissional receber `consent_required`
 * ao abrir as fichas/dados.
 *
 * O bug de raiz foi corrigido no handler de aceite (auth.ts). Esta migration
 * conserta os vínculos já existentes. Idempotente: `ON CONFLICT DO NOTHING`
 * não toca em consents já concedidos nem reativa escopos revogados pelo aluno
 * (revogados têm a linha presente → o conflito os preserva).
 */

exports.up = (pgm) => {
  // ── Personal ──────────────────────────────────────────────────────────────
  pgm.sql(`
    INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
    SELECT
      psa.student_id,
      psa.personal_id,
      'personal',
      s.scope,
      'granted'
    FROM personal_student_assignments psa
    CROSS JOIN (
      VALUES ('profile'), ('workouts'), ('daily_checkins'),
             ('metabolic'), ('sleep'), ('body_metrics'),
             ('parq_anamnese'), ('activity_logs'), ('chat_history')
    ) AS s(scope)
    WHERE psa.status = 'active'
    ON CONFLICT (user_id, professional_id, professional_role, scope) DO NOTHING
  `);

  // ── Nutri ─────────────────────────────────────────────────────────────────
  pgm.sql(`
    INSERT INTO user_data_consents (user_id, professional_id, professional_role, scope, status)
    SELECT
      npa.patient_id,
      npa.nutri_id,
      'nutri',
      s.scope,
      'granted'
    FROM nutri_patient_assignments npa
    CROSS JOIN (
      VALUES ('profile'), ('nutrition'), ('daily_checkins'),
             ('metabolic'), ('body_metrics'), ('parq_anamnese'),
             ('chat_history')
    ) AS s(scope)
    WHERE npa.status = 'active'
    ON CONFLICT (user_id, professional_id, professional_role, scope) DO NOTHING
  `);
};

// Backfill de dados — sem rollback automático (não dá para distinguir as linhas
// inseridas aqui das já existentes). No-op proposital.
exports.down = () => {};
