import pool from '../config/database';
import logger from '../lib/logger';

export type DataAccessEventType =
  | 'request.created'
  | 'request.accepted'
  | 'request.rejected'
  | 'request.cancelled'
  | 'request.expired'
  | 'consent.granted'
  | 'consent.revoked'
  | 'connection.revoked'
  | 'academy_policy.changed'
  | 'professional_network.reviewed'
  | 'offering.created'
  | 'offering.updated'
  | 'offering.archived'
  | 'subscription.created'
  | 'subscription.activated'
  | 'subscription.cancelled'
  | 'subscription.paused'
  | 'subscription.expired'
  | 'subscription.payment_failed'
  | 'voice_note.published'
  | 'voice_note.read'
  | 'sport.profile.upserted'
  | 'sport.profile.deactivated'
  | 'sport.checkin.created'
  | 'sport.camp.created'
  | 'sport.post_checkin.created'
  | 'personal.sport.read'
  | 'personal.snapshot.read'
  // Onda P5 — leitura de performance pelo personal.
  | 'personal.performance.read'
  | 'personal.performance_insight.read'
  | 'personal.ai_summary.read'
  | 'personal.dashboard.read'
  | 'nutri.plan.created'
  | 'nutri.plan.updated'
  | 'nutri.plan.ended'
  | 'nutri.observation.created'
  | 'nutri.observation.read'
  | 'nutri.context.read'
  | 'nutri.meal_heatmap.read'
  | 'nutri.adherence.read'
  | 'nutri.clinical_profile.read'
  | 'nutri.clinical_profile.updated'
  | 'nutri.data.patient_deletion'
  | 'parq.signed'
  | 'parq.medical_release_declared'
  | 'training.adaptation.applied'
  | 'training.adaptation.viewed'
  | 'training.policy.updated'
  | 'push.checkin_reminder'
  | 'student.session_touchpoint.viewed'
  | 'movement_lab.opened'
  | 'movement_lab.camera_error'
  | 'movement_lab.session_completed'
  | 'movement_lab.feedback_submitted'
  | 'retro_workout.opened'
  | 'retro_workout.date_selected'
  | 'retro_workout.submitted'
  | 'retro_workout.blocked_over_limit'
  // Módulo Performance (Spec 033) — UX do aluno sobre o próprio dado.
  | 'performance.opened'
  | 'performance.tab_viewed'
  // Onda P2 — adoção de progressão e recordes.
  | 'performance.progression_viewed'
  | 'performance.exercise_selected'
  | 'performance.prs_viewed'
  | 'performance.pr_celebrated'
  | 'performance.upgrade_cta_clicked'
  // Onda P3 — adoção do Progress Score.
  | 'performance.score_viewed'
  | 'performance.score_component_opened'
  | 'performance.score_history_viewed'
  // Onda P4 — adoção das metas.
  | 'performance.goal_created'
  | 'performance.goal_viewed'
  | 'performance.goal_completed'
  | 'performance.goal_cancelled'
  // Spec 034 C1. Só a mudança de compartilhamento entra: é a única ação de UX
  // que o aluno executa sobre um marco. O desbloqueio é servidor e já vira log
  // — a allow-list não recebe evento que ninguém emite.
  | 'community.milestone_share_changed'
  // Spec 034 C2. A leitura do painel agrega nome e progresso de vários alunos —
  // uma linha por titular lido, como nas rotas irmãs de performance.
  | 'personal.challenge_participants_viewed'
  // Onda P5 — adoção da visão do personal.
  | 'personal.performance_opened'
  | 'personal.performance_insight_opened'
  | 'personal.performance_ai_summary_requested'
  | 'personal.performance_ai_summary_shown'
  // ── Execução do treino no mobile (SPEC P1 §51/§52) ──────────────────────
  // Só o que responde às perguntas de produto do §52: quantos começam e
  // concluem, quanto tempo levam, onde abandonam, e quanto se usa treino
  // livre, repetir e reordenar. Nenhum evento carrega carga, repetição, dor,
  // nome de exercício ou qualquer sinal do corpo — a instrumentação mede o
  // USO da tela, não o treino (pacto de dados do CLAUDE.md).
  | 'workout.started'
  | 'workout.completed'
  | 'workout.abandoned'
  | 'workout.resumed'
  | 'workout.set_completed'
  | 'workout.exercise_skipped'
  | 'workout.exercise_reordered'
  // Execução dinâmica: o aluno muda a ficha DURANTE o treino. `exercise_skipped`
  // é outra coisa — pular é não fazer a série prescrita; remover tira o
  // exercício da lista do dia. Medem quanto a ficha entregue diverge da
  // executada, insumo da próxima revisão do personal.
  | 'workout.exercise_substituted'
  | 'workout.substitution_undone'
  | 'workout.exercise_added'
  | 'workout.exercise_removed'
  // Lembrete de treino não finalizado: mede se o mecanismo funciona (quantas
  // sessões chegam a ser lembradas, quantas voltam pelo toque). Nenhum dado do
  // treino viaja — nem exercício, nem carga, nem horário de treino.
  | 'workout.reminder_scheduled'
  | 'workout.reminder_opened'
  | 'workout.free_started'
  | 'workout.repeat_started'
  | 'workout.share_opened'
  // ── Camada de atividade e dispositivos (SPEC Mobile P2 §70/§71) ─────────
  // Medem o USO: quantas atividades, de que tipo, quantas do S2Core e quantas
  // importadas, taxa de conclusão, adoção do widget. NENHUM evento carrega
  // coordenada, endereço ou distância exata — rota de exercício revela casa,
  // trabalho e rotina, e a §70 proíbe explicitamente mandá-la para analytics.
  | 'activity.started'
  | 'activity.paused'
  | 'activity.resumed'
  | 'activity.completed'
  | 'activity.abandoned'
  | 'activity.recovered'
  | 'activity.discarded'
  | 'activity.gps_denied'
  | 'activity.share_opened'
  | 'health_connect.connected'
  | 'apple_health.connected'
  | 'widget.workout_started'
  // ── Prontidão (SPEC Mobile P3 §71/§72) ──────────────────────────────────
  // A §71 é literal: "não enviar health data bruto para ferramenta de
  // analytics". O payload carrega estado, confiança e modo — nunca score
  // exato, sono, dor, HRV ou componente. Isso responde às perguntas do §72
  // (adoção, taxa de check-in, recomendação seguida) sem virar prontuário.
  | 'readiness_viewed'
  | 'readiness_details_opened'
  | 'daily_checkin_started'
  | 'daily_checkin_completed'
  | 'recommendation_accepted'
  | 'recommendation_ignored'
  | 'workout_adjustment_opened'
  // Biblioteca de Exercícios Personalizados do Personal (Sprint P1). Payload
  // só flags/contagens — nunca nome de exercício, mídia ou instrução (mesma
  // regra de `workout.*` acima).
  | 'personal_custom_exercise_create_started'
  | 'personal_custom_exercise_created'
  | 'personal_custom_exercise_edited'
  | 'personal_custom_exercise_archived'
  | 'personal_custom_exercise_added_to_plan'
  // Motor de Substituições Inteligentes (Sprint P2A). Payload só
  // flags/contagens — nunca nome de exercício, motivo textual livre ou dor
  // (mesma regra de `workout.*` acima).
  | 'replacement_suggestions_opened'
  | 'replacement_suggestion_impression'
  | 'replacement_suggestion_selected'
  | 'replacement_suggestion_ignored'
  | 'replacement_manual_search_selected'
  | 'replacement_suggestions_empty'
  | 'replacement_suggestions_error'
  // Aderência, Recorrência e Insights do Personal (Sprint P2B). Emitidos pela
  // aba Performance (Insights) do cockpit e pelo drill-down/revisão assistida
  // — nunca carregam nome de exercício ou motivo de substituição (mesma regra
  // de `workout.*`/`replacement_*` acima: mede USO da tela, não o conteúdo).
  | 'personal_adherence_viewed'
  | 'personal_exercise_insight_viewed'
  | 'personal_recurring_replacement_viewed'
  | 'personal_plan_review_started'
  | 'personal_plan_review_cancelled'
  | 'personal_plan_updated_from_insight'
  | 'identity.user_created'
  | 'identity.user_reused';

export interface DataAccessAuditEntry {
  actorId: number;
  subjectUserId: number;
  eventType: DataAccessEventType;
  eventPayload?: Record<string, unknown>;
  ip?: string;
}

export async function logDataAccessEvent(
  entry: DataAccessAuditEntry,
  client?: { query: (sql: string, params?: unknown[]) => Promise<unknown> }
): Promise<void> {
  const q = client ?? pool;
  try {
    await q.query(
      `INSERT INTO data_access_audit (actor_id, subject_user_id, event_type, event_payload, ip)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        entry.actorId,
        entry.subjectUserId,
        entry.eventType,
        JSON.stringify(entry.eventPayload ?? {}),
        entry.ip ?? null,
      ]
    );
  } catch (err) {
    logger.error({ err, entry }, '[dataAccessAudit] failed to write audit entry');
  }
}

export async function getAuditTrailForUser(
  subjectUserId: number,
  limit = 50
): Promise<Array<{
  id: string;
  /** NULL = ator excluído (anonimizado pelo ON DELETE SET NULL). A linha
   *  sobrevive porque pertence à trilha DESTE titular, não à do ator. */
  actorId: number | null;
  eventType: string;
  eventPayload: Record<string, unknown>;
  createdAt: string;
}>> {
  const { rows } = await pool.query(
    `SELECT id, actor_id, event_type, event_payload, created_at
     FROM data_access_audit
     WHERE subject_user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [subjectUserId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    actorId: r.actor_id,
    eventType: r.event_type,
    eventPayload: r.event_payload,
    createdAt: r.created_at,
  }));
}
