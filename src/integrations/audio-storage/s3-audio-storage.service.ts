import { randomBytes } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AudioStoragePort, UploadIngestAudioInput } from './audio-storage.port';

@Injectable()
export class S3AudioStorageService extends AudioStoragePort implements OnModuleInit {
  private readonly logger = new Logger(S3AudioStorageService.name);
  private readonly region: string;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly keyPrefix: string;
  private readonly hasAccessKey: boolean;
  private readonly hasSecretKey: boolean;
  private readonly s3: S3Client;

  constructor(private readonly config: ConfigService) {
    super();
    this.region = this.config.get<string>('AUDIO_STORAGE_S3_REGION')?.trim() || '';
    this.bucket = this.config.get<string>('AUDIO_STORAGE_S3_BUCKET')?.trim() || '';
    this.publicBaseUrl =
      this.config.get<string>('AUDIO_STORAGE_PUBLIC_BASE_URL')?.trim() || '';
    this.keyPrefix =
      this.config.get<string>('AUDIO_STORAGE_S3_KEY_PREFIX')?.trim() || 'ingest-audio';
    const accessKeyId =
      this.config.get<string>('AUDIO_STORAGE_S3_ACCESS_KEY_ID')?.trim() || '';
    const secretAccessKey =
      this.config.get<string>('AUDIO_STORAGE_S3_SECRET_ACCESS_KEY')?.trim() || '';
    this.hasAccessKey = Boolean(accessKeyId);
    this.hasSecretKey = Boolean(secretAccessKey);
    this.s3 = new S3Client({
      region: this.region || undefined,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  onModuleInit(): void {
    this.logger.log(
      `S3 audio storage: bucket=${this.bucket || '(vazio)'} region=${this.region || '(vazio)'} ` +
        `publicBase=${this.publicBaseUrl || '(derivado)'} prefix=${this.keyPrefix} ` +
        `credentials=${this.hasAccessKey && this.hasSecretKey ? 'ok' : 'INCOMPLETAS'}`,
    );
  }

  override async uploadIngestAudio(
    input: UploadIngestAudioInput,
  ): Promise<string | null> {
    if (!this.bucket || !this.region) {
      this.logger.warn(
        'S3 não configurado (AUDIO_STORAGE_S3_BUCKET/AUDIO_STORAGE_S3_REGION). Upload ignorado.',
      );
      return null;
    }
    if (!this.hasAccessKey || !this.hasSecretKey) {
      this.logger.warn(
        'Credenciais S3 ausentes (AUDIO_STORAGE_S3_ACCESS_KEY_ID / AUDIO_STORAGE_S3_SECRET_ACCESS_KEY).',
      );
      return null;
    }
    if (!input.buffer?.length) {
      this.logger.warn(
        `Buffer de áudio vazio — upload ignorado (trackHint=${input.trackIdHint ?? 'n/a'} owner=${input.ownerSub ?? 'n/a'}).`,
      );
      return null;
    }

    const owner = sanitizeForPath(input.ownerSub);
    const hint = sanitizeForPath(input.trackIdHint || 'track');
    const objectKey =
      `${this.keyPrefix}/${owner}/${hint}-${randomBytes(6).toString('hex')}.mp3`.replace(
        /^\/+/,
        '',
      );

    this.logger.log(
      `S3 upload iniciado: key=${objectKey} bytes=${input.buffer.length} mime=${input.mimeType || 'audio/mpeg'}`,
    );

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: input.buffer,
          ContentType: input.mimeType || 'audio/mpeg',
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: string }).name)
          : 'unknown';
      this.logger.error(
        `S3 PutObject falhou: key=${objectKey} code=${code} message=${message}`,
      );
      throw err;
    }

    const publicUrl = this.toPublicUrl(objectKey);
    this.logger.log(`S3 upload concluído: key=${objectKey} url=${publicUrl}`);
    return publicUrl;
  }

  private toPublicUrl(objectKey: string): string {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/+$/, '')}/${objectKey.replace(
        /^\/+/,
        '',
      )}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${objectKey}`;
  }
}

function sanitizeForPath(value: string): string {
  const v = (value || '').trim().toLowerCase();
  if (!v) return 'unknown';
  return v
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^-+|-+$/g, '');
}
