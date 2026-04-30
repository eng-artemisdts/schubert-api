import type { IngestJobStatus } from '../schemas/ingest-job.schema';

export type IngestJobResponseDto = {
  jobId: string;
  status: IngestJobStatus;
  progressPercent: number;
  currentStage: string;
  resultTrackId?: string;
  error?: string;
  stages: Array<{
    stageName: string;
    status: string;
    startedAt?: Date;
    endedAt?: Date;
    durationMs?: number;
    cacheHit?: boolean;
    error?: string;
  }>;
};
