import type {
  TranscriptionLyricSegmentSubdoc,
  TranscriptionLyricSyllableSubdoc,
  TranscriptionLyricWordSubdoc,
} from '../../tracks/schemas/track.schema';

function parseLrcTimestampSec(ts: string): number {
  const m = ts.match(/^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return NaN;
  const mm = Number(m[1]);
  const ss = Number(m[2]);
  const fracRaw = m[3] ?? '0';
  const frac = Number(`0.${fracRaw.padEnd(3, '0').slice(0, 3)}`);
  return mm * 60 + ss + frac;
}

/**
 * Converte linhas LRC sincronizadas em segmentos alinhados ao subdocumento de letras do Track.
 */
export function lrcSyncedTextToSegments(
  syncedLyrics: string,
  durationSec?: number,
): TranscriptionLyricSegmentSubdoc[] {
  const rows = syncedLyrics
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = rows
    .map((line) => {
      const m = line.match(/^\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]\s*(.*)$/);
      if (!m) return null;
      const start = parseLrcTimestampSec(m[1]);
      const text = m[2].trim();
      if (!Number.isFinite(start) || !text) return null;
      return { start, text };
    })
    .filter((x): x is { start: number; text: string } => !!x)
    .sort((a, b) => a.start - b.start);

  if (!parsed.length) return [];

  return parsed.map((cur, idx) => {
    const nextStart = parsed[idx + 1]?.start;
    const maxEnd =
      typeof durationSec === 'number' && durationSec > 0
        ? durationSec
        : cur.start + 4;
    const end = Number(
      Math.max(cur.start + 0.05, Math.min(nextStart ?? maxEnd, maxEnd)).toFixed(3),
    );
    const wordsText = cur.text.split(/\s+/).filter(Boolean);
    const dur = Math.max(0.05, end - cur.start);
    const words: TranscriptionLyricWordSubdoc[] = wordsText.map((w, wi) => {
      const ws = cur.start + (wi / wordsText.length) * dur;
      const we = cur.start + ((wi + 1) / wordsText.length) * dur;
      const syllables: TranscriptionLyricSyllableSubdoc[] = [
        { syllable: w, start: Number(ws.toFixed(3)), end: Number(we.toFixed(3)) },
      ];
      return {
        word: w,
        start: Number(ws.toFixed(3)),
        end: Number(we.toFixed(3)),
        syllables,
      };
    });

    return {
      start: Number(cur.start.toFixed(3)),
      end,
      text: cur.text,
      language: 'unknown',
      words,
    };
  });
}

/** Letra só texto (sem LRC) → um único segmento. */
export function plainLyricsToSingleSegment(text: string): TranscriptionLyricSegmentSubdoc[] {
  const t = text.trim();
  if (!t) return [];
  const words = t.split(/\s+/).filter(Boolean).map((w) => ({
    word: w,
    syllables: [{ syllable: w, start: 0, end: 0 }] as TranscriptionLyricSyllableSubdoc[],
  }));
  return [{ start: 0, end: 0, text: t, language: 'unknown', words }];
}
