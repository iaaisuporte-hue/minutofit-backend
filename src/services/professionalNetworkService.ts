import pool from '../config/database';
import { logDataAccessEvent } from './dataAccessAuditService';
import type { ProfessionalRole } from './consentService';

export type NetworkPolicyMode = 'allow' | 'block';
export type CredentialStatus = 'pending_review' | 'approved' | 'rejected';
export type PublicationStatus = 'draft' | 'pending_review' | 'approved' | 'disabled';
export type AvailabilityStatus = 'available' | 'limited' | 'unavailable';

export interface ProfessionalNetworkProfileInput {
  professionalRole: ProfessionalRole;
  credentialCode: string;
  displayName: string;
  bio?: string | null;
  photoUrl?: string | null;
  specialties?: string[];
  metabolicFocus?: string | null;
  modality?: 'in_person' | 'online' | 'hybrid' | null;
  city?: string | null;
  stateUf?: string | null;
  availabilityStatus?: AvailabilityStatus;
}

export interface ProfessionalNetworkProfile {
  professionalId: number;
  professionalRole: ProfessionalRole;
  credentialCode: string;
  credentialStatus: CredentialStatus;
  publicationStatus: PublicationStatus;
  adminEnabled: boolean;
  displayName: string;
  bio: string | null;
  photoUrl: string | null;
  specialties: string[];
  metabolicFocus: string | null;
  modality: 'in_person' | 'online' | 'hybrid' | null;
  city: string | null;
  stateUf: string | null;
  availabilityStatus: AvailabilityStatus;
  reviewedAt: string | null;
  reviewNotes: string | null;
  updatedAt: string;
}

export interface NetworkProfessionalCard {
  professionalId: number;
  professionalRole: ProfessionalRole;
  displayName: string;
  photoUrl: string | null;
  specialties: string[];
  metabolicFocus: string | null;
  modality: 'in_person' | 'online' | 'hybrid' | null;
  city: string | null;
  stateUf: string | null;
  availabilityStatus: AvailabilityStatus;
  credentialCode: string;
  credentialStatus: CredentialStatus;
}

function normalizeArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function mapProfile(row: Record<string, unknown>): ProfessionalNetworkProfile {
  return {
    professionalId: Number(row.professional_id),
    professionalRole: row.professional_role as ProfessionalRole,
    credentialCode: String(row.credential_code ?? ''),
    credentialStatus: row.credential_status as CredentialStatus,
    publicationStatus: row.publication_status as PublicationStatus,
    adminEnabled: Boolean(row.admin_enabled),
    displayName: String(row.display_name ?? ''),
    bio: (row.bio as string | null) ?? null,
    photoUrl: (row.photo_url as string | null) ?? null,
    specialties: normalizeArray(row.specialties),
    metabolicFocus: (row.metabolic_focus as string | null) ?? null,
    modality: (row.modality as 'in_person' | 'online' | 'hybrid' | null) ?? null,
    city: (row.city as string | null) ?? null,
    stateUf: (row.state_uf as string | null) ?? null,
    availabilityStatus: row.availability_status as AvailabilityStatus,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    reviewNotes: (row.review_notes as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}

function mapCard(row: Record<string, unknown>): NetworkProfessionalCard {
  const profile = mapProfile(row);
  return {
    professionalId: profile.professionalId,
    professionalRole: profile.professionalRole,
    displayName: profile.displayName,
    photoUrl: profile.photoUrl,
    specialties: profile.specialties,
    metabolicFocus: profile.metabolicFocus,
    modality: profile.modality,
    city: profile.city,
    stateUf: profile.stateUf,
    availabilityStatus: profile.availabilityStatus,
    credentialCode: profile.credentialCode,
    credentialStatus: profile.credentialStatus,
  };
}

export async function getAcademyNetworkPolicy(
  academyId: number | null | undefined
): Promise<{ mode: NetworkPolicyMode; updatedAt: string | null; updatedByUserId: number | null }> {
  if (!academyId) {
    return { mode: 'allow', updatedAt: null, updatedByUserId: null };
  }

  const { rows } = await pool.query(
    `SELECT mode, updated_at, updated_by_user_id
     FROM academy_professional_network_policies
     WHERE academy_id = $1`,
    [academyId]
  );

  if (!rows[0]) {
    return { mode: 'block', updatedAt: null, updatedByUserId: null };
  }

  return {
    mode: rows[0].mode,
    updatedAt: rows[0].updated_at,
    updatedByUserId: rows[0].updated_by_user_id,
  };
}

export async function upsertAcademyNetworkPolicy(opts: {
  academyId: number;
  mode: NetworkPolicyMode;
  actorId: number;
  ip?: string;
}) {
  const { academyId, mode, actorId, ip } = opts;
  const before = await getAcademyNetworkPolicy(academyId);
  const { rows } = await pool.query(
    `INSERT INTO academy_professional_network_policies
       (academy_id, mode, updated_by_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (academy_id) DO UPDATE
       SET mode = EXCLUDED.mode,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = NOW()
     RETURNING mode, updated_at, updated_by_user_id`,
    [academyId, mode, actorId]
  );

  await logDataAccessEvent({
    actorId,
    subjectUserId: actorId,
    eventType: 'academy_policy.changed',
    eventPayload: { academyId, from: before.mode, to: mode, surface: 'professional_network' },
    ip,
  });

  return {
    mode: rows[0].mode as NetworkPolicyMode,
    updatedAt: rows[0].updated_at as string,
    updatedByUserId: rows[0].updated_by_user_id as number,
  };
}

export async function listAvailableProfessionals(opts: {
  academyId?: number | null;
  professionalRole?: ProfessionalRole;
  limit?: number;
}): Promise<{ policy: NetworkPolicyMode; professionals: NetworkProfessionalCard[] }> {
  // Tese MaaS: produtos são modulares. Aluno pode contratar profissionais independente
  // da academia. A policy é mantida na tabela para telemetria/uso futuro, mas não bloqueia.
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 24);
  const params: unknown[] = [];
  let roleFilter = '';
  if (opts.professionalRole) {
    params.push(opts.professionalRole);
    roleFilter = `AND p.professional_role = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT p.*
     FROM professional_network_profiles p
     JOIN users u ON u.id = p.professional_id AND u.role = p.professional_role
     WHERE p.publication_status = 'approved'
       AND p.credential_status = 'approved'
       AND p.admin_enabled = TRUE
       AND p.availability_status IN ('available','limited')
       ${roleFilter}
     ORDER BY
       CASE p.availability_status WHEN 'available' THEN 0 ELSE 1 END,
       CASE p.professional_role WHEN 'personal' THEN 0 ELSE 1 END,
       p.updated_at DESC
     LIMIT $${params.length}`,
    params
  );

  return { policy: 'allow', professionals: rows.map(mapCard) };
}

export async function getAvailableProfessionalDetail(opts: {
  academyId?: number | null;
  professionalId: number;
}): Promise<{ policy: NetworkPolicyMode; professional: NetworkProfessionalCard | null }> {
  // Acesso à rede de profissionais é independente da policy da academia (tese MaaS modular).
  const { rows } = await pool.query(
    `SELECT p.*
     FROM professional_network_profiles p
     JOIN users u ON u.id = p.professional_id AND u.role = p.professional_role
     WHERE p.professional_id = $1
       AND p.publication_status = 'approved'
       AND p.credential_status = 'approved'
       AND p.admin_enabled = TRUE
       AND p.availability_status IN ('available','limited')
     LIMIT 1`,
    [opts.professionalId]
  );

  return { policy: 'allow', professional: rows[0] ? mapCard(rows[0]) : null };
}

export async function assertProfessionalCanReceiveDiscoveryRequest(opts: {
  academyId?: number | null;
  professionalId: number;
  professionalRole: ProfessionalRole;
}) {
  const { professional } = await getAvailableProfessionalDetail({
    academyId: opts.academyId ?? null,
    professionalId: opts.professionalId,
  });
  if (!professional || professional.professionalRole !== opts.professionalRole) {
    throw Object.assign(new Error('professional_not_available'), { status: 404 });
  }
}

export async function getOwnNetworkProfile(professionalId: number): Promise<ProfessionalNetworkProfile | null> {
  const { rows } = await pool.query(
    `SELECT * FROM professional_network_profiles WHERE professional_id = $1 LIMIT 1`,
    [professionalId]
  );
  return rows[0] ? mapProfile(rows[0]) : null;
}

export async function upsertOwnNetworkProfile(opts: {
  professionalId: number;
  input: ProfessionalNetworkProfileInput;
}): Promise<ProfessionalNetworkProfile> {
  const i = opts.input;
  const specialties = (i.specialties ?? []).slice(0, 5).map((s) => s.trim()).filter(Boolean);
  if (!i.credentialCode.trim()) {
    throw Object.assign(new Error('credential_required'), { status: 400 });
  }
  if (!i.displayName.trim()) {
    throw Object.assign(new Error('display_name_required'), { status: 400 });
  }

  const { rows } = await pool.query(
    `INSERT INTO professional_network_profiles
       (professional_id, professional_role, credential_code, display_name, bio, photo_url,
        specialties, metabolic_focus, modality, city, state_uf, availability_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
     ON CONFLICT (professional_id) DO UPDATE
       SET credential_status = CASE
             WHEN professional_network_profiles.credential_code IS DISTINCT FROM EXCLUDED.credential_code THEN 'pending_review'
             ELSE professional_network_profiles.credential_status
           END,
           admin_enabled = CASE
             WHEN professional_network_profiles.credential_code IS DISTINCT FROM EXCLUDED.credential_code THEN FALSE
             ELSE professional_network_profiles.admin_enabled
           END,
           credential_code = EXCLUDED.credential_code,
           display_name = EXCLUDED.display_name,
           bio = EXCLUDED.bio,
           photo_url = EXCLUDED.photo_url,
           specialties = EXCLUDED.specialties,
           metabolic_focus = EXCLUDED.metabolic_focus,
           modality = EXCLUDED.modality,
           city = EXCLUDED.city,
           state_uf = EXCLUDED.state_uf,
           availability_status = EXCLUDED.availability_status,
           publication_status = CASE
             WHEN professional_network_profiles.publication_status = 'approved' THEN 'pending_review'
             ELSE professional_network_profiles.publication_status
           END,
           updated_at = NOW()
     RETURNING *`,
    [
      opts.professionalId,
      i.professionalRole,
      i.credentialCode.trim(),
      i.displayName.trim(),
      i.bio?.trim() || null,
      i.photoUrl?.trim() || null,
      JSON.stringify(specialties),
      i.metabolicFocus?.trim() || null,
      i.modality ?? null,
      i.city?.trim() || null,
      i.stateUf?.trim().toUpperCase() || null,
      i.availabilityStatus ?? 'available',
    ]
  );

  return mapProfile(rows[0]);
}

export async function submitOwnNetworkProfileForReview(professionalId: number): Promise<ProfessionalNetworkProfile> {
  const profile = await getOwnNetworkProfile(professionalId);
  if (!profile) throw Object.assign(new Error('profile_not_found'), { status: 404 });

  const missing = [
    !profile.credentialCode ? 'credentialCode' : null,
    !profile.displayName ? 'displayName' : null,
    !profile.bio ? 'bio' : null,
    profile.specialties.length === 0 ? 'specialties' : null,
    !profile.modality ? 'modality' : null,
  ].filter(Boolean);
  if (missing.length) {
    throw Object.assign(new Error('incomplete_profile'), { status: 400, details: missing });
  }

  // MVP: auto-aprovação sem gate de admin. Preserva o data model para curadoria futura.
  const { rows } = await pool.query(
    `UPDATE professional_network_profiles
     SET publication_status = 'approved', credential_status = 'approved', admin_enabled = TRUE, updated_at = NOW()
     WHERE professional_id = $1
     RETURNING *`,
    [professionalId]
  );
  return mapProfile(rows[0]);
}

export async function unpublishOwnNetworkProfile(professionalId: number): Promise<ProfessionalNetworkProfile> {
  const { rows } = await pool.query(
    `UPDATE professional_network_profiles
     SET publication_status = 'draft', admin_enabled = FALSE, updated_at = NOW()
     WHERE professional_id = $1
     RETURNING *`,
    [professionalId]
  );
  if (!rows[0]) throw Object.assign(new Error('profile_not_found'), { status: 404 });
  return mapProfile(rows[0]);
}

export async function reviewNetworkProfile(opts: {
  professionalId: number;
  reviewerId: number;
  credentialStatus: CredentialStatus;
  publicationStatus: PublicationStatus;
  adminEnabled: boolean;
  reviewNotes?: string | null;
  ip?: string;
}): Promise<ProfessionalNetworkProfile> {
  const { rows } = await pool.query(
    `UPDATE professional_network_profiles
     SET credential_status = $2,
         publication_status = $3,
         admin_enabled = $4,
         review_notes = $5,
         reviewed_by_user_id = $6,
         reviewed_at = NOW(),
         updated_at = NOW()
     WHERE professional_id = $1
     RETURNING *`,
    [
      opts.professionalId,
      opts.credentialStatus,
      opts.publicationStatus,
      opts.adminEnabled,
      opts.reviewNotes ?? null,
      opts.reviewerId,
    ]
  );

  if (!rows[0]) throw Object.assign(new Error('profile_not_found'), { status: 404 });

  await logDataAccessEvent({
    actorId: opts.reviewerId,
    subjectUserId: opts.professionalId,
    eventType: 'professional_network.reviewed',
    eventPayload: {
      credentialStatus: opts.credentialStatus,
      publicationStatus: opts.publicationStatus,
      adminEnabled: opts.adminEnabled,
    },
    ip: opts.ip,
  });

  return mapProfile(rows[0]);
}
