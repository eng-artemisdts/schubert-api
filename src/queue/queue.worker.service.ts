import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import { IngestJobsService } from '../ingest-jobs/ingest-jobs.service';
import { IngestService } from '../ingest/ingest.service';
import { INGEST_JOB_NAME, INGEST_QUEUE_NAME } from './queue.constants';
import type { IngestQueuePayload } from './queue.producer.service';

@Injectable()
export class QueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueWorkerService.name);
  private worker: Worker | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly ingestService: IngestService,
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
    this.worker = new Worker(
      INGEST_QUEUE_NAME,
      async (job: Job<IngestQueuePayload>) => this.processJob(job),
      {
        connection: { url: redisUrl },
        concurrency: Number(this.config.get<string>('INGEST_QUEUE_CONCURRENCY') || 1),
      },
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

  private async processJob(job: Job<IngestQueuePayload>): Promise<void> {
    if (job.name !== INGEST_JOB_NAME) return;
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
      caller: {
        auth0Sub: d.ownerSub,
        billingPlan: 'free',
        auth0ApiPermissions: [],
        appPermissions: [],
        scope: null,
        billingPlanSource: 'none',
      },
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
    const trackId =
      typeof (track as unknown as { trackId?: string }).trackId === 'string'
        ? (track as unknown as { trackId?: string }).trackId
        : undefined;
    const trackObjectId =
      typeof (track as unknown as { _id?: unknown })._id?.toString === 'function'
        ? (track as unknown as { _id: { toString: () => string } })._id.toString()
        : undefined;
    await this.ingestJobs.updateStage(d.jobId, 'processIngest', 'completed', {
      progressPercent: 95,
    });
    await job.log(
      `[${d.jobId}] etapa=processIngest status=completed trackId=${trackId ?? ''}`,
    );
    await job.updateProgress(95);
    await this.ingestJobs.markCompleted(d.jobId, { trackId, trackObjectId });
    await job.updateProgress(100);
  }
}
