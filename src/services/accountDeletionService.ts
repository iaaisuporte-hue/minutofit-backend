/**
 * Exclusão e Exportação de Conta (Spec 025). Núcleo compartilhado pela rota
 * self-service do aluno (`DELETE /user/account`) e pelo admin-delete — evita
 * divergência da limpeza de storage (fix f57e539) e da anonimização financeira.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import pool from '../config/database';
import logger from '../lib/logger';
import { getStorage, isStorageConfigured } from '../lib/storage';
import { recordStorageOrphan } from './storageOrphanService';

export type DeletionActor = 'self' | 'admin';

function emailHash(email: string | null): string {
  return crypto.createHash('sha256').update((email ?? '').toLowerCase().trim()).digest('hex');
}

/**
 * Anonimiza registros financeiros ANTES do DELETE do usuário: desvincula user_id
 * (PII) e marca. Como o user_id vira NULL, o ON DELETE CASCADE não toca essas
 * linhas — valores/datas/status/gateway_id ficam para fisco/chargeback.
 */
async function anonymizeFinancials(client: PoolClient, userId: number, hash: string): Promise<void> {
  for (const table of ['payments', 'user_subscriptions']) {
    await client.query(
      `UPDATE ${table}
          SET user_id = NULL, anonymized_at = NOW(), anonymized_user_hash = $2
        WHERE user_id = $1`,
      [userId, hash],
    );
  }
}

export interface DeleteResult {
  storageObjectsDeleted: number;
}

/**
 * Exclui a conta do usuário: anonimiza financeiro, enumera as fotos, apaga o
 * usuário (CASCADE no resto), grava o tombstone, e SÓ APÓS o COMMIT remove os
 * objetos no storage (rede ao R2 fora da transação — rollback ⇒ storage intocado).
 */
export async function deleteUserAccount(
  userId: number,
  opts: { requestedBy: DeletionActor; reason?: string },
): Promise<DeleteResult> {
  const userRes = await pool.query<{ email: string | null }>(
    `SELECT email FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  if (userRes.rows.length === 0) {
    const err = new Error('user_not_found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  const hash = emailHash(userRes.rows[0].email);

  const client = await pool.connect();
  let photoKeys: string[] = [];
  try {
    await client.query('BEGIN');

    await anonymizeFinancials(client, userId, hash);

    // Tabelas sem CASCADE que referenciam o usuário — limpar explicitamente.
    await client.query(`DELETE FROM personal_direct_invites WHERE accepted_user_id = $1`, [userId]);

    // Fotos de progresso (LGPD art. 11): CASCADE apaga as LINHAS, não os binários.
    const photoRes = await client.query<{ storage_key: string }>(
      `SELECT storage_key FROM progress_photos WHERE user_id = $1`,
      [userId],
    );
    photoKeys = photoRes.rows.map((r) => r.storage_key);

    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

    await client.query(
      `INSERT INTO account_deletions (user_id, email_hash, requested_by, reason, storage_objects_deleted)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, hash, opts.requestedBy, opts.reason ?? null, photoKeys.length],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Pós-COMMIT: purga best-effort dos objetos no storage. Falhas viram órfãos
  // registrados (Spec 023) para o job de varredura reconciliar — nunca silencioso.
  const orphanReason = opts.requestedBy === 'admin' ? 'admin_user_delete' : 'student_delete';
  let deleted = 0;
  if (photoKeys.length > 0) {
    if (!isStorageConfigured()) {
      await Promise.all(
        photoKeys.map((key) => recordStorageOrphan(key, 'storage_not_configured', { userId })),
      );
    } else {
      const storage = getStorage();
      for (const key of photoKeys) {
        try {
          await storage.deleteObject(key);
          deleted += 1;
        } catch (delErr: any) {
          await recordStorageOrphan(key, orphanReason, { userId }, delErr?.message);
        }
      }
    }
  }

  return { storageObjectsDeleted: deleted };
}

// ===========================================================================
// Exportação (SAR / LGPD art. 18) — read-only, agregada, escopada por user_id.
// Cada seção é best-effort: uma consulta que falhe não derruba o export inteiro.
// ===========================================================================

async function section<T = any>(label: string, sql: string, params: any[]): Promise<T[]> {
  try {
    const { rows } = await pool.query(sql, params);
    return rows as T[];
  } catch (err: any) {
    logger.warn({ err: err?.message, section: label }, '[account-export] seção falhou (ignorada)');
    return [];
  }
}

export async function exportUserData(userId: number): Promise<Record<string, unknown>> {
  const [profile] = await section('profile',
    `SELECT id, name, email, role, phone, fitness_goal, experience_level, height_cm, weight_kg, created_at
       FROM users WHERE id = $1`, [userId]);

  const [workoutSessions, dailyCheckins, metabolicCheckins, nutritionPlans, adherence, mealCheckins, consents, messages, photos, sport] =
    await Promise.all([
      section('workout_sessions', `SELECT * FROM workout_sessions WHERE user_id = $1 ORDER BY id`, [userId]),
      section('daily_checkins', `SELECT * FROM user_daily_checkins WHERE user_id = $1 ORDER BY id`, [userId]),
      section('metabolic_checkins', `SELECT * FROM user_metabolic_checkins WHERE user_id = $1 ORDER BY id`, [userId]),
      section('nutrition_plans', `SELECT * FROM nutrition_plans WHERE patient_id = $1 ORDER BY id`, [userId]),
      section('nutrition_adherence', `SELECT * FROM nutrition_adherence_checkins WHERE patient_id = $1 ORDER BY id`, [userId]),
      section('meal_checkins', `SELECT * FROM nutrition_meal_checkins WHERE patient_id = $1 ORDER BY id`, [userId]),
      section('consents', `SELECT scope, professional_id, professional_role, status, granted_at, revoked_at FROM user_data_consents WHERE user_id = $1`, [userId]),
      section('messages', `SELECT id, conversation_id, sender_role, text, created_at FROM chat_messages WHERE sender_id = $1 ORDER BY id`, [userId]),
      section('progress_photos', `SELECT id, storage_key, content_type, taken_at, pose, note, status, created_at FROM progress_photos WHERE user_id = $1 AND status = 'active' ORDER BY id`, [userId]),
      section('sport_profile', `SELECT * FROM user_sport_profile WHERE user_id = $1`, [userId]),
    ]);

  // URLs de leitura assinadas curtas para as fotos (não expor storage_key cru).
  let photosWithUrls = photos;
  if (isStorageConfigured() && photos.length > 0) {
    const storage = getStorage();
    photosWithUrls = await Promise.all(
      photos.map(async (p: any) => ({
        ...p,
        storage_key: undefined,
        url: await storage.createDownloadUrl(p.storage_key, 600).catch(() => null),
      })),
    );
  }

  return {
    exportedAt: new Date().toISOString(),
    profile: profile ?? null,
    workoutSessions,
    dailyCheckins,
    metabolicCheckins,
    nutrition: { plans: nutritionPlans, adherence, mealCheckins },
    progressPhotos: photosWithUrls,
    consents,
    messages,
    sportProfile: sport[0] ?? null,
  };
}
