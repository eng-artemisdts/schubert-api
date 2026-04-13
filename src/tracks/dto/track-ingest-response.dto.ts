/** Resposta de `POST /tracks/ingest` — documento `Track` persistido (JSON). */
export type TrackIngestResponseDto = {
  track: Record<string, unknown>;
};
