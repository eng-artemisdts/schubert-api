import type {
  TranscriptionChordEventSubdoc,
  TranscriptionSectionSubdoc,
} from '../../tracks/schemas/track.schema';

export type ChordSectionAnalysisResult = {
  chords: TranscriptionChordEventSubdoc[];
  sections: TranscriptionSectionSubdoc[];
  /** Tonalidade / afinação devolvida pelo workflow (ex.: Music.AI `key`); string vazia se não existir. */
  original_tune: string;
};

/** Análise de acordes e secções a partir de um ficheiro de áudio (ex.: music.ai). */
export interface IChordSectionProvider {
  analyze(audioPath: string): Promise<ChordSectionAnalysisResult>;
}
