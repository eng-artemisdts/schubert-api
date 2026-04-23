import type {
  TranscriptionLyricSegmentSubdoc,
  TranscriptionLyricSyllableSubdoc,
  TranscriptionLyricWordSubdoc,
} from '../../tracks/schemas/track.schema';

function normToken(raw: unknown): string {
  return String(raw ?? '')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '')
    .trim();
}

function toWordEntry(w: Record<string, unknown>): TranscriptionLyricWordSubdoc {
  const text = normToken(w.word ?? w.text ?? w.token ?? '');
  const st = Number(w.start ?? w.startTime ?? w.begin ?? 0);
  const en = Number(w.end ?? w.endTime ?? w.finish ?? st);
  const syllable: TranscriptionLyricSyllableSubdoc = {
    syllable: text || ' ',
    start: st,
    end: en,
  };
  return { word: text, start: st, end: en, syllables: [syllable] };
}

function tryLine(
  o: Record<string, unknown>,
): { start: number; end: number; text: string; words?: unknown[] } | null {
  const text = normToken(
    o.text ?? o.line ?? o.lyric ?? o.value ?? o.content ?? '',
  );
  const start = Number(
    o.start ?? o.startTime ?? o.begin ?? o.tStart ?? o.from ?? NaN,
  );
  const end = Number(o.end ?? o.endTime ?? o.finish ?? o.tEnd ?? o.to ?? NaN);
  if (!text && !Number.isFinite(start)) return null;
  return {
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : Number.isFinite(start) ? start : 0,
    text,
    words: Array.isArray(o.words)
      ? o.words
      : Array.isArray(o.tokens)
        ? o.tokens
        : undefined,
  };
}

/**
 * Converte o JSON devolvido pela AudioShake Tasks API (várias formas) para segmentos do Track.
 */
export function audioshakeJsonToLyricSegments(
  raw: unknown,
  languageLabel: string,
): TranscriptionLyricSegmentSubdoc[] {
  const data =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  let candidates =
    (data.lines as unknown[]) ??
    (data.segments as unknown[]) ??
    (data.utterances as unknown[]) ??
    ((data.transcript as Record<string, unknown>)?.lines as unknown[]) ??
    ((data.transcription as Record<string, unknown>)?.lines as unknown[]) ??
    ((data.result as Record<string, unknown>)?.lines as unknown[]);

  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object') {
    candidates = raw as unknown[];
  }

  const segments: {
    start: number;
    end: number;
    text: string;
    words?: unknown[];
  }[] = [];
  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      if (c && typeof c === 'object') {
        const line = tryLine(c as Record<string, unknown>);
        if (line) segments.push(line);
      }
    }
  }

  if (!segments.length) return [];

  return segments.map((seg) => {
    let mappedWords: TranscriptionLyricWordSubdoc[] = [];
    if (Array.isArray(seg.words) && seg.words.length) {
      mappedWords = seg.words
        .filter(
          (w): w is Record<string, unknown> => !!w && typeof w === 'object',
        )
        .map((w) => toWordEntry(w))
        .filter((e) => e.word.length);
    }
    if (!mappedWords.length && seg.text) {
      const parts = normToken(seg.text).split(/\s+/).filter(Boolean);
      const dur = Math.max(0.01, seg.end - seg.start);
      const slice = dur / Math.max(parts.length, 1);
      mappedWords = parts.map((p, i) =>
        toWordEntry({
          word: p,
          start: seg.start + i * slice,
          end: seg.start + (i + 1) * slice,
        }),
      );
    }
    return {
      start: seg.start,
      end: seg.end,
      text: normToken(seg.text),
      language: languageLabel,
      words: mappedWords,
    };
  });
}
