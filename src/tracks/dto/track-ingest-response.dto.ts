/** Resposta de `POST /tracks/ingest` — documento `Track` persistido (JSON). */
export type TrackIngestResponseDto = {
  track?: Record<string, unknown>;
  jobId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  progressPercent?: number;
};
