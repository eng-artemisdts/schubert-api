import type { TranscriptionLyricSegmentSubdoc } from '../../tracks/schemas/track.schema';

export type LrclibSearchInput = {
  title: string;
  artist: string;
  album?: string;
  /** Segundos (ex.: a partir de `duration_ms` / 1000). */
  durationSec?: number;
};

export type LyricsMatchResult = {
  segments: TranscriptionLyricSegmentSubdoc[];
};

/** Pesquisa de letra sincronizada (ex.: LRCLIB) a partir de metadados de faixa. */
export interface ILyricsSearchProvider {
  search(input: LrclibSearchInput): Promise<LyricsMatchResult | null>;
}
