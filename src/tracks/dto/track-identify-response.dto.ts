import type { RecognizedSongDto } from '../../integrations/music-recognition/recognized-song.dto';

export type TrackIdentifyResponseDto = {
  recognized: boolean;
  song: RecognizedSongDto | null;
  /** Present when `recognized` is true and a matching `Track` exists in MongoDB. */
  track: Record<string, unknown> | null;
  /** `true` quando a cifra canónica existe e o utilizador ainda não tem variação própria. */
  canCreateVariation?: boolean;
  /** `true` quando o utilizador pode abrir o editor da cifra retornada. */
  canEditTrack?: boolean;
};
