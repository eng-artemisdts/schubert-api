import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';

import { buildIngestCallerLogPayload } from '../auth/caller-context.util';
import type { JwtAuthUser } from '../auth/jwt.strategy';
import { IngestJobsService } from '../ingest-jobs/ingest-jobs.service';
import type { IngestJobResponseDto } from '../ingest-jobs/dto/ingest-job-response.dto';
import { QueueProducerService } from '../queue/queue.producer.service';
import type { TrackDocument } from '../tracks/schemas/track.schema';
import { MAX_MP3_UPLOAD_BYTES } from '../upload-limits.constants';
import { IngestService } from './ingest.service';

function trackToJson(track: TrackDocument): Record<string, unknown> {
  const t = track as unknown as { toJSON?: () => Record<string, unknown> };
  if (typeof t.toJSON === 'function') {
    return t.toJSON();
  }
  return track as unknown as Record<string, unknown>;
}

type RequestWithJwtUser = Request & { user?: JwtAuthUser };

function isMp3Upload(file: Express.Multer.File): boolean {
  const name = (file.originalname ?? '').toLowerCase();
  const mime = (file.mimetype ?? '').toLowerCase();
  return name.endsWith('.mp3') || mime === 'audio/mpeg' || mime === 'audio/mp3';
}

@Controller('tracks')
export class IngestController {
  constructor(
    private readonly ingestService: IngestService,
    private readonly config: ConfigService,
    private readonly ingestJobs: IngestJobsService,
    private readonly queueProducer: QueueProducerService,
  ) { }

  @Get('ingest/jobs/:jobId')
  async getIngestJob(@Param('jobId') jobId: string): Promise<IngestJobResponseDto> {
    const doc = await this.ingestJobs.getByJobId(jobId.trim());
    return this.ingestJobs.toResponse(doc);
  }

  @Post('ingest')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_MP3_UPLOAD_BYTES,
        /** JSON `meta` como campo de texto — default busboy/multer é 1 MB; evita truncagem no parse. */
        fieldSize: MAX_MP3_UPLOAD_BYTES,
      },
    }),
  )
  async ingest(
    @Req() req: RequestWithJwtUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('meta') metaRaw?: string | Record<string, unknown>,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        'Envie um ficheiro MP3 no campo multipart `file`.',
      );
    }

    if (!isMp3Upload(file)) {
      throw new BadRequestException(
        'Apenas ficheiros .mp3 são aceites para ingestão.',
      );
    }

    const caller = buildIngestCallerLogPayload(req, req.user);
    const asyncEnabled = this.config.get<string>('INGEST_ASYNC_ENABLED') === '1';
    if (!asyncEnabled) {
      const track = await this.ingestService.run({
        file,
        metaRaw,
        caller,
      });
      return { track: trackToJson(track), status: 'completed' };
    }

    const idempotencyKey = this.ingestJobs.createIdempotencyKey({
      ownerSub: caller.auth0Sub,
      fileBuffer: file.buffer,
      metaRaw,
    });
    const existing = await this.ingestJobs.findActiveByIdempotencyKey(idempotencyKey);
    if (existing) {
      return {
        jobId: existing.jobId,
        status: existing.status,
        progressPercent: existing.progressPercent,
      };
    }

    const job = await this.ingestJobs.createQueuedJob({
      ownerSub: caller.auth0Sub,
      idempotencyKey,
      inputRef: {
        fileName: file.originalname,
        fileSize: file.size,
      },
    });
    await this.queueProducer.enqueueIngest({
      jobId: job.jobId,
      ownerSub: caller.auth0Sub,
      fileName: file.originalname || 'upload.mp3',
      mimeType: file.mimetype || 'audio/mpeg',
      fileBase64: file.buffer.toString('base64'),
      metaRaw: metaRaw ?? null,
      caller,
    });
    return { jobId: job.jobId, status: 'queued', progressPercent: 0 };
  }

  /**
   * Stub temporário: o fluxo de ingestão a partir de uma faixa Spotify foi removido enquanto se
   * desenha um substituto sem dependência do `ytdl-mp3` / `@distube/ytdl-core` (que falha a
   * extrair o player.js actual do YouTube e despeja ficheiros de debug no CWD do processo).
   *
   * Mantemos a rota para não partir o cliente; o body é ignorado.
   */
  @Post('ingest/spotify')
  @HttpCode(HttpStatus.ACCEPTED)
  ingestSpotify(): { ok: true } {
    return { ok: true };
  }
}
