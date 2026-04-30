import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type IngestJobDocument = HydratedDocument<IngestJob>;

export const INGEST_JOB_STATUS = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type IngestJobStatus = (typeof INGEST_JOB_STATUS)[number];

export const INGEST_STAGE_STATUS = ['queued', 'running', 'completed', 'failed'] as const;
export type IngestStageStatus = (typeof INGEST_STAGE_STATUS)[number];

@Schema({ _id: false })
export class IngestStage {
  @Prop({ required: true })
  stageName: string;

  @Prop({ required: true, enum: INGEST_STAGE_STATUS, default: 'queued' })
  status: IngestStageStatus;

  @Prop()
  startedAt?: Date;

  @Prop()
  endedAt?: Date;

  @Prop()
  durationMs?: number;

  @Prop({ default: false })
  cacheHit?: boolean;

  @Prop()
  error?: string;
}

const IngestStageSchema = SchemaFactory.createForClass(IngestStage);

@Schema({ collection: 'ingest_jobs', timestamps: true })
export class IngestJob {
  @Prop({ required: true, unique: true, index: true })
  jobId: string;

  @Prop({ required: true, index: true })
  ownerSub: string;

  @Prop({ required: true, enum: INGEST_JOB_STATUS, default: 'queued', index: true })
  status: IngestJobStatus;

  @Prop({ required: true, default: 0 })
  progressPercent: number;

  @Prop({ default: 'queued' })
  currentStage: string;

  @Prop({ index: true })
  idempotencyKey?: string;

  @Prop({ type: Object, default: undefined })
  inputRef?: Record<string, unknown>;

  @Prop()
  resultTrackId?: string;

  @Prop()
  resultTrackObjectId?: string;

  @Prop()
  error?: string;

  @Prop({ type: [IngestStageSchema], default: [] })
  stages: IngestStage[];
}

export const IngestJobSchema = SchemaFactory.createForClass(IngestJob);
IngestJobSchema.index({ ownerSub: 1, createdAt: -1 });
