import pool from '../config/database';

export type ClearanceReason =
  | 'ok'
  | 'never_signed'
  | 'expired'
  | 'incomplete_health_flags'
  /**
   * Respondeu "sim" a pelo menos uma das 7 perguntas do PAR-Q e ainda não
   * declarou liberação médica. Antes desse estado, `parq_any_yes` era calculado,
   * gravado e hasheado como evidência — e ignorado na hora de liberar: quem
   * marcava "sente dor no peito ao se exercitar?" treinava igual.
   */
  | 'medical_clearance_required'
  | 'not_applicable';

export interface PhysicalActivityClearance {
  valid: boolean;
  signedAt: string | null;
  expiresAt: string | null;
  reason: ClearanceReason;
}

const cache = new Map<number, { expiresAt: number; value: PhysicalActivityClearance }>();
const CACHE_TTL_MS = 60_000;

export function invalidateClearanceCache(userId: number): void {
  cache.delete(userId);
}

export function deriveClearance(row: {
  role: string;
  parq_signed_at?: Date | string | null;
  parq_expires_at?: Date | string | null;
  parq_signature_data?: string | null;
  parq_any_yes?: boolean | null;
  parq_medical_release_at?: Date | string | null;
  sem_historico_hipertensao?: boolean | null;
  sem_historico_cardiaco?: boolean | null;
  sem_restricao_medica_exercicio?: boolean | null;
  apto_para_atividade_fisica?: boolean | null;
  aceita_responsabilidade_informacoes?: boolean | null;
}): PhysicalActivityClearance {
  if (row.role !== 'user') {
    return { valid: true, signedAt: null, expiresAt: null, reason: 'not_applicable' };
  }

  // As 4 primeiras são CONDIÇÕES DE SAÚDE (o aluno tem ou não tem); a quinta é
  // um ACEITE (declara que as informações são verdadeiras). Naturezas diferentes,
  // tratamentos diferentes:
  //
  // - Não respondeu (null) → `incomplete_health_flags`: falta preencher.
  // - Respondeu que TEM a condição (false) → não é "incompleto", é um sinal
  //   clínico: cai em `medical_clearance_required`, junto com o "sim" do PAR-Q.
  //   Antes tudo que não fosse `true` virava "incompleto", e como o formulário
  //   só salvava com as 5 marcadas, o único caminho para usar o app era
  //   declarar-se saudável. Quem tinha hipertensão não tinha caminho nenhum.
  // - O aceite continua obrigatório: sem ele não há evidência válida.
  const healthConditions = [
    row.sem_historico_hipertensao,
    row.sem_historico_cardiaco,
    row.sem_restricao_medica_exercicio,
    row.apto_para_atividade_fisica,
  ];

  const healthAnswered =
    healthConditions.every((v) => typeof v === 'boolean') &&
    typeof row.aceita_responsabilidade_informacoes === 'boolean';

  if (!healthAnswered || row.aceita_responsabilidade_informacoes !== true) {
    return { valid: false, signedAt: null, expiresAt: null, reason: 'incomplete_health_flags' };
  }

  const declaredHealthCondition = healthConditions.some((v) => v === false);

  if (!row.parq_signed_at || !row.parq_signature_data) {
    return { valid: false, signedAt: null, expiresAt: null, reason: 'never_signed' };
  }

  const signedAt = new Date(row.parq_signed_at).toISOString();
  const expiresAt = row.parq_expires_at ? new Date(row.parq_expires_at).toISOString() : null;

  if (!expiresAt || new Date(expiresAt) <= new Date()) {
    return { valid: false, signedAt, expiresAt, reason: 'expired' };
  }

  // "Sim" em qualquer pergunta do PAR-Q — ou condição de saúde declarada — pede
  // avaliação médica antes de treinar. Não é bloqueio definitivo: o aluno
  // declara a liberação obtida e segue. Bloquear sem saída só ensinaria a
  // responder "não" em tudo, que é o pior desfecho possível para uma triagem.
  if ((row.parq_any_yes === true || declaredHealthCondition) && !row.parq_medical_release_at) {
    return { valid: false, signedAt, expiresAt, reason: 'medical_clearance_required' };
  }

  return { valid: true, signedAt, expiresAt, reason: 'ok' };
}

export async function getClearanceForUser(userId: number): Promise<PhysicalActivityClearance> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit.value;

  const { rows } = await pool.query(
    `SELECT
       role,
       parq_signed_at,
       parq_expires_at,
       parq_signature_data,
       parq_any_yes,
       parq_medical_release_at,
       sem_historico_hipertensao,
       sem_historico_cardiaco,
       sem_restricao_medica_exercicio,
       apto_para_atividade_fisica,
       aceita_responsabilidade_informacoes
     FROM users WHERE id = $1`,
    [userId]
  );

  if (rows.length === 0) {
    return { valid: false, signedAt: null, expiresAt: null, reason: 'never_signed' };
  }

  const value = deriveClearance(rows[0]);
  cache.set(userId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}
