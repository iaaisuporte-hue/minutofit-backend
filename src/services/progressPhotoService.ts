/**
 * Fotos de Progresso (Spec 020) — orquestra DB (progress_photos) + object storage.
 *
 * Regras de segurança que vivem AQUI (defesa de posse, não confiar no cliente):
 * - A `storage_key` é derivada no servidor a partir do `userId` autenticado
 *   (`progress-photos/{userId}/{uuid}.{ext}`) — o cliente nunca escolhe a chave.
 * - Ao registrar, validamos que a `storageKey` recebida pertence ao prefixo do
 *   próprio usuário ANTES de inserir — impede reivindicar objeto de terceiro.
 * - Listagem/remoção sempre filtram por `user_id`.
 * - Leitura por profissional usa `listPhotosForSubject` (por id do titular); a
 *   AUTORIZAÇÃO (vínculo + consent `body_photos`) é imposta na ROTA, não aqui.
 */
import { randomUUID } from 'crypto';
import pool from '../config/database';
import { getStorage, assertStorageConfigured } from '../lib/storage';
import { hasActiveConsent, type ProfessionalRole } from './consentService';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const UPLOAD_URL_TTL = 300; // s
const DOWNLOAD_URL_TTL = 300; // s

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

export type ProgressPose = 'front' | 'side' | 'back' | 'other';

export interface ProgressPhoto {
  id: number;
  takenAt: string;
  pose: ProgressPose | null;
  note: string | null;
  url: string;
  expiresIn: number;
}

function keyPrefix(userId: number): string {
  return `progress-photos/${userId}/`;
}

/** Passo 1 do upload: valida tipo/tamanho e devolve PUT presigned + a chave (derivada do userId). */
export async function createUploadTarget(
  userId: number,
  contentType: string,
  byteSize: number,
): Promise<{ uploadUrl: string; storageKey: string; expiresIn: number }> {
  assertStorageConfigured();
  const ext = EXT_BY_TYPE[contentType];
  if (!ext) {
    const err = new Error('unsupported_content_type');
    (err as any).code = 'VALIDATION';
    throw err;
  }
  if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > MAX_BYTES) {
    const err = new Error('invalid_byte_size');
    (err as any).code = 'VALIDATION';
    throw err;
  }
  const storageKey = `${keyPrefix(userId)}${randomUUID()}.${ext}`;
  const { uploadUrl, expiresIn } = await getStorage().createUploadUrl(storageKey, contentType, UPLOAD_URL_TTL);
  return { uploadUrl, storageKey, expiresIn };
}

/** Passo 2: confirma o objeto no storage, valida posse da chave e cria a linha. */
export async function registerPhoto(
  userId: number,
  input: { storageKey: string; takenAt?: string; pose?: ProgressPose; note?: string },
): Promise<ProgressPhoto> {
  assertStorageConfigured();
  // Posse: a chave TEM de estar sob o prefixo do próprio usuário.
  if (typeof input.storageKey !== 'string' || !input.storageKey.startsWith(keyPrefix(userId))) {
    const err = new Error('forbidden_storage_key');
    (err as any).code = 'FORBIDDEN';
    throw err;
  }
  const head = await getStorage().headObject(input.storageKey);
  if (!head) {
    const err = new Error('object_not_found');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  if (head.byteSize && head.byteSize > MAX_BYTES) {
    // Objeto maior que o permitido (cliente ignorou o limite no PUT): rejeita e limpa.
    await getStorage().deleteObject(input.storageKey).catch(() => {});
    const err = new Error('object_too_large');
    (err as any).code = 'VALIDATION';
    throw err;
  }
  const pose = input.pose && ['front', 'side', 'back', 'other'].includes(input.pose) ? input.pose : null;
  const note = typeof input.note === 'string' ? input.note.slice(0, 280) : null;
  const takenAt = typeof input.takenAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.takenAt) ? input.takenAt : null;

  const { rows } = await pool.query<{ id: number; taken_at: string; pose: ProgressPose | null; note: string | null }>(
    `INSERT INTO progress_photos (user_id, storage_key, content_type, byte_size, taken_at, pose, note)
     VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7)
     RETURNING id, taken_at, pose, note`,
    [userId, input.storageKey, head.contentType ?? null, head.byteSize ?? null, takenAt, pose, note],
  );
  const row = rows[0];
  const url = await getStorage().createDownloadUrl(input.storageKey, DOWNLOAD_URL_TTL);
  return { id: row.id, takenAt: row.taken_at, pose: row.pose, note: row.note, url, expiresIn: DOWNLOAD_URL_TTL };
}

/** Galeria do próprio aluno (sempre filtrada por user_id; dono não precisa de consent). */
export async function listPhotosForUser(userId: number): Promise<ProgressPhoto[]> {
  return listPhotosBySubject(userId);
}

/**
 * Leitura profissional — ÚNICO caminho exportado para um profissional ver fotos
 * de OUTRO usuário. Reaplica a checagem de consent `body_photos` AQUI (não só na
 * rota): defesa em profundidade contra um futuro caller que esqueça o gate.
 * Lança `CONSENT_REQUIRED` se não houver consent ativo do par (aluno, prof, role).
 */
export async function listPhotosForProfessional(
  subjectUserId: number,
  professionalId: number,
  role: ProfessionalRole,
): Promise<ProgressPhoto[]> {
  const allowed = await hasActiveConsent(subjectUserId, professionalId, role, 'body_photos');
  if (!allowed) {
    const err = new Error('consent_required');
    (err as any).code = 'CONSENT_REQUIRED';
    throw err;
  }
  return listPhotosBySubject(subjectUserId);
}

/**
 * Busca crua por titular. PRIVADA de propósito (não exportada) — assim o único
 * jeito de um profissional chegar aqui é via `listPhotosForProfessional`, que
 * exige consent. O dono chega via `listPhotosForUser` (próprio id).
 */
async function listPhotosBySubject(subjectUserId: number): Promise<ProgressPhoto[]> {
  assertStorageConfigured();
  const { rows } = await pool.query<{ id: number; storage_key: string; taken_at: string; pose: ProgressPose | null; note: string | null }>(
    `SELECT id, storage_key, taken_at, pose, note
       FROM progress_photos
      WHERE user_id = $1 AND status = 'active'
      ORDER BY taken_at DESC, id DESC`,
    [subjectUserId],
  );
  const storage = getStorage();
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      takenAt: r.taken_at,
      pose: r.pose,
      note: r.note,
      url: await storage.createDownloadUrl(r.storage_key, DOWNLOAD_URL_TTL),
      expiresIn: DOWNLOAD_URL_TTL,
    })),
  );
}

/** Soft-delete (só o dono) + remoção best-effort do objeto no storage. */
export async function deletePhoto(userId: number, photoId: number): Promise<boolean> {
  const { rows } = await pool.query<{ storage_key: string }>(
    `UPDATE progress_photos SET status = 'deleted', updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'active'
      RETURNING storage_key`,
    [photoId, userId],
  );
  if (rows.length === 0) return false;
  await getStorage().deleteObject(rows[0].storage_key).catch(() => {});
  return true;
}
