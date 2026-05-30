import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';

import { IngestUrlService } from '../ingest/ingest-url.service';
import { IngestJobsService } from '../ingest-jobs/ingest-jobs.service';
import { IngestService } from '../ingest/ingest.service';
import { INGEST_JOB_NAME, INGEST_QUEUE_NAME, INGEST_URL_JOB_NAME } from './queue.constants';
import type { IngestQueuePayload, IngestUrlQueuePayload } from './queue.producer.service';

@Injectable()
export class QueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueWorkerService.name);
  private worker: Worker | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly ingestService: IngestService,
    private readonly ingestUrlService: IngestUrlService,
    private readonly ingestJobs: IngestJobsService,
    @Inject(INGEST_QUEUE_NAME)
    private readonly queue: unknown | null,
  ) {}

  onModuleInit(): void {
    const redisUrl = this.config.get<string>('REDIS_URL')?.trim();
    const asyncEnabled = this.config.get<string>('INGEST_ASYNC_ENABLED') === '1';
    if (!asyncEnabled || !redisUrl) {
      this.logger.log(
        'Worker de ingest desativado (INGEST_ASYNC_ENABLED!=1 ou REDIS_URL ausente).',
      );
      return;
    }
    /** BullMQ default lock é 30s — ingestão (yt-dlp, IA, etc.) demora minutos; sem isto: "could not renew lock". */
    const lockParsed = Number(this.config.get<string>('INGEST_QUEUE_LOCK_DURATION_MS'));
    const lockDurationMs =
      Number.isFinite(lockParsed) && lockParsed >= 60_000 ? lockParsed : 30 * 60 * 1000;
    const stalledParsed = Number(this.config.get<string>('INGEST_QUEUE_STALLED_INTERVAL_MS'));
    const stalledIntervalMs =
      Number.isFinite(stalledParsed) && stalledParsed >= 5_000
        ? stalledParsed
        : Math.min(Math.max(Math.floor(lockDurationMs / 3), 10_000), 120_000);

    this.worker = new Worker(
      INGEST_QUEUE_NAME,
      async (job: Job<IngestQueuePayload | IngestUrlQueuePayload>) => this.processJob(job),
      {
        connection: { url: redisUrl },
        concurrency: Number(this.config.get<string>('INGEST_QUEUE_CONCURRENCY') || 1),
        lockDuration: lockDurationMs,
        stalledInterval: stalledIntervalMs,
      },
    );
    this.logger.log(
      `Worker BullMQ: lockDuration=${lockDurationMs}ms stalledInterval=${stalledIntervalMs}ms`,
    );

    this.worker.on('failed', async (job, err) => {
      if (!job?.data?.jobId) return;
      await job.log(
        `[${job.data.jobId}] etapa=processIngest status=failed error=${err?.message || ''}`,
      );
      await this.ingestJobs.markFailed(
        job.data.jobId,
        err?.message || 'Falha no worker de ingest.',
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }

  private async processJob(job: Job<IngestQueuePayload | IngestUrlQueuePayload>): Promise<void> {
    if (job.name === INGEST_JOB_NAME) {
      await this.processFileIngestJob(job as Job<IngestQueuePayload>);
      return;
    }
    if (job.name === INGEST_URL_JOB_NAME) {
      await this.processUrlIngestJob(job as Job<IngestUrlQueuePayload>);
      return;
    }
    this.logger.warn(`Nome de job BullMQ não suportado: ${job.name}`);
  }

  private async processUrlIngestJob(job: Job<IngestUrlQueuePayload>): Promise<void> {
    const d = job.data;
    await job.log(`[${d.jobId}] etapa=resolveSource status=running`);
    await job.updateProgress(2);

    const track = await this.ingestUrlService.processUrlIngestFromQueue(d);

    await this.finalizeIngestJob(job, d.jobId, track);
  }

  private async processFileIngestJob(job: Job<IngestQueuePayload>): Promise<void> {
    const d = job.data;
    await job.log(`[${d.jobId}] etapa=processIngest status=running`);
    await job.updateProgress(5);
    await this.ingestJobs.updateStage(d.jobId, 'processIngest', 'running', { progressPercent: 5 });
    const fileBuffer = Buffer.from(d.fileBase64, 'base64');
    const track = await this.ingestService.run({
      file: {
        buffer: fileBuffer,
        originalname: d.fileName,
        mimetype: d.mimeType,
      } as Express.Multer.File,
      metaRaw: d.metaRaw,
      caller: d.caller,
      onStage: async (evt) => {
        await this.ingestJobs.updateStage(d.jobId, evt.stage, evt.status, {
          progressPercent: evt.progressPercent,
          cacheHit: evt.cacheHit,
          error: evt.error,
        });
        await job.log(
          `[${d.jobId}] etapa=${evt.stage} status=${evt.status} progress=${evt.progressPercent}% cacheHit=${evt.cacheHit === true}`,
        );
        await job.updateProgress(evt.progressPercent);
      },
    });
    await this.finalizeIngestJob(job, d.jobId, track);
  }

  private async finalizeIngestJob(
    job: Job<IngestQueuePayload | IngestUrlQueuePayload>,
    jobId: string,
    track: unknown,
  ): Promise<void> {
    const trackId =
      typeof (track as { trackId?: string }).trackId === 'string'
        ? (track as { trackId?: string }).trackId
        : undefined;
    const trackObjectId =
      typeof (track as { _id?: { toString: () => string } })._id?.toString === 'function'
        ? (track as { _id: { toString: () => string } })._id.toString()
        : undefined;
    await this.ingestJobs.updateStage(jobId, 'processIngest', 'completed', {
      progressPercent: 95,
    });
    await job.log(`[${jobId}] etapa=processIngest status=completed trackId=${trackId ?? ''}`);
    await job.updateProgress(95);
    await this.ingestJobs.markCompleted(jobId, { trackId, trackObjectId });
    await job.updateProgress(100);
  }
}
