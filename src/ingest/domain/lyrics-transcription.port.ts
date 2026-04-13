import type { TranscriptionLyricSegmentSubdoc } from '../../tracks/schemas/track.schema';

export type TranscriptionOptions = {
  language?: string;
};

/** Transcrição de letra com alinhamento temporal (Whisper, AudioShake, etc.). */
export interface ILyricsTranscriptionProvider {
  transcribe(
    audioPath: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionLyricSegmentSubdoc[]>;
}
