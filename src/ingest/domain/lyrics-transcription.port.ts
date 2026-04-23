import type { TranscriptionLyricSegmentSubdoc } from '../../tracks/schemas/track.schema';

export type TranscriptionOptions = {
  language?: string;
};

/** Transcrição de letra com alinhamento temporal (AudioShake e futuros provedores). */
export interface ILyricsTranscriptionProvider {
  transcribe(
    audioPath: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionLyricSegmentSubdoc[]>;
}
