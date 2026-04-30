import { randomBytes, createHash } from 'crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  IngestJob,
  IngestJobDocument,
  IngestStageStatus,
} from './schemas/ingest-job.schema';
import type { IngestJobResponseDto } from './dto/ingest-job-response.dto';

@Injectable()
export class IngestJobsService {
  constructor(
    @InjectModel(IngestJob.name)
    private readonly ingestJobModel: Model<IngestJobDocument>,
  ) {}

  createIdempotencyKey(input: {
    ownerSub: string;
    fileBuffer: Buffer;
    metaRaw: unknown;
  }): string {
    const hash = createHash('sha256');
    hash.update(input.ownerSub);
    hash.update(input.fileBuffer);
    hash.update(typeof input.metaRaw === 'string' ? input.metaRaw : JSON.stringify(input.metaRaw ?? {}));
    return hash.digest('hex');
  }

  async findActiveByIdempotencyKey(key: string): Promise<IngestJobDocument | null> {
    return this.ingestJobModel
      .findOne({
        idempotencyKey: key,
        status: { $in: ['queued', 'running', 'completed'] },
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  async createQueuedJob(input: {
    ownerSub: string;
    idempotencyKey?: string;
    inputRef?: Record<string, unknown>;
  }): Promise<IngestJobDocument> {
    const jobId = `ij_${randomBytes(8).toString('hex')}`;
    return this.ingestJobModel.create({
      jobId,
      ownerSub: input.ownerSub,
      status: 'queued',
      progressPercent: 0,
      currentStage: 'queued',
      idempotencyKey: input.idempotencyKey,
      inputRef: input.inputRef,
      stages: [],
    });
  }

  async getByJobId(jobId: string): Promise<IngestJobDocument> {
    const doc = await this.ingestJobModel.findOne({ jobId }).exec();
    if (!doc) throw new NotFoundException(`Ingest job «${jobId}» não encontrado.`);
    return doc;
  }

  async updateStage(
    jobId: string,
    stageName: string,
    status: IngestStageStatus,
    options?: { cacheHit?: boolean; error?: string; progressPercent?: number },
  ): Promise<void> {
    const doc = await this.getByJobId(jobId);
    const now = new Date();
    const idx = doc.stages.findIndex((s) => s.stageName === stageName);
    if (idx < 0) {
      doc.stages.push({
        stageName,
        status,
        startedAt: status === 'running' ? now : undefined,
        endedAt: status === 'completed' || status === 'failed' ? now : undefined,
        cacheHit: options?.cacheHit ?? false,
        error: options?.error,
      } as never);
    } else {
      const s = doc.stages[idx];
      s.status = status;
      if (status === 'running' && !s.startedAt) s.startedAt = now;
      if (status === 'completed' || status === 'failed') {
        s.endedAt = now;
        if (s.startedAt) s.durationMs = now.getTime() - s.startedAt.getTime();
      }
      if (options?.cacheHit !== undefined) s.cacheHit = options.cacheHit;
      if (options?.error) s.error = options.error;
    }
    doc.currentStage = stageName;
    if (options?.progressPercent !== undefined) doc.progressPercent = options.progressPercent;
    if (status === 'running') doc.status = 'running';
    await doc.save();
  }

  async markCompleted(jobId: string, input: { trackId?: string; trackObjectId?: string }) {
    await this.ingestJobModel
      .updateOne(
        { jobId },
        {
          $set: {
            status: 'completed',
            progressPercent: 100,
            currentStage: 'completed',
            resultTrackId: input.trackId,
            resultTrackObjectId: input.trackObjectId,
          },
        },
      )
      .exec();
  }

  async markFailed(jobId: string, message: string) {
    await this.ingestJobModel
      .updateOne(
        { jobId },
        {
          $set: {
            status: 'failed',
            currentStage: 'failed',
            error: message.slice(0, 2000),
          },
        },
      )
      .exec();
  }

  toResponse(doc: IngestJobDocument): IngestJobResponseDto {
    return {
      jobId: doc.jobId,
      status: doc.status,
      progressPercent: doc.progressPercent,
      currentStage: doc.currentStage,
      resultTrackId: doc.resultTrackId,
      error: doc.error,
      stages: (doc.stages ?? []).map((s) => ({
        stageName: s.stageName,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
        cacheHit: s.cacheHit,
        error: s.error,
      })),
    };
  }
}
