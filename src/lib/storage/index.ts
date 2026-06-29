/**
 * Camada de object storage — abstração com S3 como provider padrão.
 *
 * Por que abstrair: a borda (bucket/credencial/endpoint) deve ser trocável sem
 * tocar nos services. O provider S3 fala o protocolo S3, então serve AWS S3 e
 * qualquer S3-compatível (Cloudflare R2, MinIO) só mudando `AWS_S3_ENDPOINT`.
 * A escolha definitiva de provider (AWS vs R2 por custo/egress) fica para depois.
 *
 * DEGRADAÇÃO NÃO-SILENCIOSA (requisito explícito): sem config, NÃO falhamos
 * mudo. (1) Log de aviso no boot fora de produção; (2) toda chamada lança
 * `StorageNotConfiguredError` → as rotas respondem 503; (3) `isStorageConfigured()`
 * alimenta `GET /api/health` (`storage: unset`) como sinal visível em dev/staging.
 *
 * Objetos são SEMPRE privados. Nunca geramos URL pública — só URLs assinadas
 * curtas (PUT para upload, GET para leitura), geradas sob demanda.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import logger from '../logger';

export class StorageNotConfiguredError extends Error {
  code = 'STORAGE_NOT_CONFIGURED' as const;
  constructor() {
    super('Object storage não configurado (defina AWS_S3_BUCKET + credenciais).');
    this.name = 'StorageNotConfiguredError';
  }
}

export interface UploadTarget {
  uploadUrl: string;
  expiresIn: number;
}

export interface ObjectHead {
  contentType?: string;
  byteSize?: number;
}

export interface StorageProvider {
  readonly name: string;
  isConfigured(): boolean;
  createUploadUrl(key: string, contentType: string, expiresIn: number): Promise<UploadTarget>;
  createDownloadUrl(key: string, expiresIn: number): Promise<string>;
  headObject(key: string): Promise<ObjectHead | null>;
  deleteObject(key: string): Promise<void>;
}

/** Provider S3 (e S3-compatíveis via AWS_S3_ENDPOINT). */
class S3Provider implements StorageProvider {
  readonly name = 'aws-s3';
  private _client: S3Client | null = null;
  private readonly bucket = process.env.AWS_S3_BUCKET || '';
  private readonly region = process.env.AWS_REGION || 'us-east-1';
  private readonly endpoint = process.env.AWS_S3_ENDPOINT || undefined; // R2/MinIO

  // Path-style: padrão TRUE quando há endpoint custom (R2/MinIO precisam), salvo
  // override explícito. AWS S3 puro (sem endpoint) usa virtual-host (false).
  private get forcePathStyle(): boolean {
    if (process.env.AWS_S3_FORCE_PATH_STYLE === 'true') return true;
    if (process.env.AWS_S3_FORCE_PATH_STYLE === 'false') return false;
    return Boolean(this.endpoint);
  }

  isConfigured(): boolean {
    return Boolean(
      this.bucket &&
        process.env.AWS_ACCESS_KEY_ID &&
        process.env.AWS_SECRET_ACCESS_KEY,
    );
  }

  private client(): S3Client {
    if (!this.isConfigured()) throw new StorageNotConfiguredError();
    if (!this._client) {
      this._client = new S3Client({
        region: this.region,
        endpoint: this.endpoint,
        forcePathStyle: this.forcePathStyle,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      });
    }
    return this._client;
  }

  async createUploadUrl(key: string, contentType: string, expiresIn: number): Promise<UploadTarget> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    const uploadUrl = await getSignedUrl(this.client(), cmd, { expiresIn });
    return { uploadUrl, expiresIn };
  }

  async createDownloadUrl(key: string, expiresIn: number): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client(), cmd, { expiresIn });
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.client().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { contentType: out.ContentType, byteSize: out.ContentLength };
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let _provider: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  if (!_provider) _provider = new S3Provider();
  return _provider;
}

export function isStorageConfigured(): boolean {
  return getStorage().isConfigured();
}

/** Lança 503-friendly se o storage não está pronto. Usar no topo das rotas de upload/leitura. */
export function assertStorageConfigured(): void {
  if (!isStorageConfigured()) throw new StorageNotConfiguredError();
}

/** Aviso de boot (não-silencioso) quando o storage não está configurado fora de produção. */
export function warnIfStorageUnconfigured(): void {
  if (!isStorageConfigured()) {
    const where = process.env.NODE_ENV || 'development';
    logger.warn(
      { provider: getStorage().name, env: where },
      '[storage] NÃO CONFIGURADO — uploads de foto responderão 503. Defina AWS_S3_BUCKET + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (e AWS_S3_ENDPOINT para R2).',
    );
  }
}
