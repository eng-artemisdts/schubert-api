import type { RecognizedSongDto } from '../../integrations/music-recognition/recognized-song.dto';

/** Resposta de `POST /tracks/ingest` (áudio + metadados de reconhecimento). */
export type TrackIngestResponseDto = {
  accepted: true;
  /** Eco do objeto `song` enviado em `meta` (após validação), ou `null` se `meta` omitido. */
  song: RecognizedSongDto | null;
};
