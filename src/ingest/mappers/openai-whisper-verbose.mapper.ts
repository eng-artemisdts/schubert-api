import type {
  TranscriptionLyricSegmentSubdoc,
  TranscriptionLyricSyllableSubdoc,
  TranscriptionLyricWordSubdoc,
} from '../../tracks/schemas/track.schema';

type WhisperVerbose = {
  segments?: { start: number; end: number; text?: string }[];
  text?: string;
};

/**
 * Mapeia `response_format=verbose_json` da API OpenAI Whisper para segmentos do Track.
 */
export function openAiWhisperVerboseToSegments(raw: unknown): TranscriptionLyricSegmentSubdoc[] {
  if (!raw || typeof raw !== 'object') return [];
  const v = raw as WhisperVerbose;
  const segs = v.segments;
  if (!Array.isArray(segs) || !segs.length) {
    const t = typeof v.text === 'string' ? v.text.trim() : '';
    if (!t) return [];
    const words: TranscriptionLyricWordSubdoc[] = t.split(/\s+/).filter(Boolean).map((w) => ({
      word: w,
      syllables: [{ syllable: w, start: 0, end: 0 }] as TranscriptionLyricSyllableSubdoc[],
    }));
    return [{ start: 0, end: 0, text: t, language: 'unknown', words }];
  }

  return segs
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s) => {
      const text = (s.text ?? '').trim();
      const parts = text.split(/\s+/).filter(Boolean);
      const dur = Math.max(0.05, s.end - s.start);
      const slice = dur / Math.max(parts.length, 1);
      const words: TranscriptionLyricWordSubdoc[] = parts.map((w, i) => {
        const ws = s.start + i * slice;
        const we = s.start + (i + 1) * slice;
        return {
          word: w,
          start: Number(ws.toFixed(3)),
          end: Number(we.toFixed(3)),
          syllables: [{ syllable: w, start: Number(ws.toFixed(3)), end: Number(we.toFixed(3)) }],
        };
      });
      return {
        start: s.start,
        end: s.end,
        text,
        language: 'unknown',
        words,
      };
    });
}
