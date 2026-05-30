import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';

import type { IngestCallerLogPayload } from '../auth/caller-context.util';
import type { IngestUrlDto } from '../ingest/dto/ingest-url.dto';
import type { SourcePlatform } from '../ingest/platform-detect.util';
import { INGEST_JOB_NAME, INGEST_QUEUE_NAME, INGEST_URL_JOB_NAME } from './queue.constants';

export type IngestQueuePayload = {
  jobId: string;
  ownerSub: string;
  fileName: string;
  mimeType: string;
  fileBase64: string;
  metaRaw: unknown;
  caller: IngestCallerLogPayload;
};

export type IngestUrlQueuePayload = {
  jobId: string;
  ownerSub: string;
  dto: IngestUrlDto;
  platform: SourcePlatform;
  caller: IngestCallerLogPayload;
};

@Injectable()
export class QueueProducerService {
  private readonly logger = new Logger(QueueProducerService.name);
  constructor(
    private readonly config: ConfigService,
    @Inject(INGEST_QUEUE_NAME)
    private readonly queue: Queue | null,
  ) { }

  isAvailable(): boolean {
    return Boolean(this.queue);
  }

  private ingestJobOptions(jobId: string) {
    return {
      jobId,
      attempts: Number(this.config.get<string>('INGEST_QUEUE_ATTEMPTS') || 3),
      backoff: {
        type: 'exponential' as const,
        delay: Number(this.config.get<string>('INGEST_QUEUE_BACKOFF_MS') || 1000),
      },
      keepLogs: Number(this.config.get<string>('INGEST_QUEUE_KEEP_LOGS') || 500),
      removeOnComplete: 1000,
      removeOnFail: 1000,
    };
  }

  async enqueueIngest(payload: IngestQueuePayload): Promise<void> {
    if (!this.queue) {
      throw new Error('Queue indisponível: REDIS_URL não configurado');
    }
    await this.queue.add(INGEST_JOB_NAME, payload, this.ingestJobOptions(payload.jobId));
    this.logger.log(`Job enfileirado: ${payload.jobId}`);
  }

  async enqueueIngestUrl(payload: IngestUrlQueuePayload): Promise<void> {
    if (!this.queue) {
      throw new Error('Queue indisponível: REDIS_URL não configurado');
    }
    await this.queue.add(INGEST_URL_JOB_NAME, payload, this.ingestJobOptions(payload.jobId));
    this.logger.log(`Job URL enfileirado: ${payload.jobId} plataforma=${payload.platform}`);
  }
}
