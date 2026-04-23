import type { TranscriptionChordEventSubdoc } from './schemas/track.schema';

const BEATS_PER_BAR = 4;
const DEFAULT_BPM = 120;
const NC = 'N.C.';

function secondsToBarBeat(
  seconds: number,
  bpm: number,
): { bar: number; beat: number } {
  const s = Math.max(0, seconds);
  const totalBeats = (s * bpm) / 60;
  const whole = Math.floor(totalBeats);
  return {
    bar: Math.floor(whole / BEATS_PER_BAR) + 1,
    beat: (whole % BEATS_PER_BAR) + 1,
  };
}

function estimateBpm(
  durationSec: number | undefined,
  chords: { start: number; end: number }[],
): number {
  if (!durationSec || durationSec <= 0 || chords.length < 2) return DEFAULT_BPM;
  const last = Math.max(...chords.map((c) => c.end));
  if (last <= 0) return DEFAULT_BPM;
  const approxBeats = Math.max(
    chords.length,
    Math.ceil((last / durationSec) * 32),
  );
  const bpm = (approxBeats / last) * 60;
  return Math.min(200, Math.max(72, Math.round(bpm)));
}

function pickNum(
  o: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function pickStr(
  o: Record<string, unknown>,
  keys: string[],
  fallback: string,
): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return fallback;
}

/**
 * Converte um acorde vindo do cliente (start/end obrigatórios) para o subdocumento completo,
 * recalculando barras e tempos a partir de `start`/`end` quando necessário.
 */
export function normalizeChordEventFromClient(
  raw: unknown,
  bpm: number,
): TranscriptionChordEventSubdoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const start = pickNum(o, ['start']);
  const end = pickNum(o, ['end']);
  if (start === undefined || end === undefined) return null;
  const startT = Math.max(0, start);
  const endT = Math.max(startT, end);
  const maj = pickStr(o, ['chord_majmin', 'chordMajmin'], NC);
  const startBB = secondsToBarBeat(startT, bpm);
  const endBB = secondsToBarBeat(endT, bpm);
  const bass = o.bass === null || o.bass === undefined ? null : String(o.bass);
  const bassN =
    o.bass_nashville === null || o.bass_nashville === undefined
      ? null
      : String(o.bass_nashville);
  return {
    start: startT,
    end: endT,
    start_bar: startBB.bar,
    start_beat: startBB.beat,
    end_bar: endBB.bar,
    end_beat: endBB.beat,
    chord_majmin: maj,
    bass: bass || null,
    bass_nashville: bassN || null,
    chord_complex_jazz: pickStr(o, ['chord_complex_jazz'], maj),
    chord_simple_jazz: pickStr(o, ['chord_simple_jazz'], maj),
    chord_basic_jazz: pickStr(o, ['chord_basic_jazz'], maj),
    chord_complex_pop: pickStr(o, ['chord_complex_pop'], maj),
    chord_simple_pop: pickStr(o, ['chord_simple_pop'], maj),
    chord_basic_pop: pickStr(o, ['chord_basic_pop'], maj),
    chord_complex_nashville: pickStr(o, ['chord_complex_nashville'], maj),
    chord_simple_nashville: pickStr(o, ['chord_simple_nashville'], maj),
    chord_basic_nashville: pickStr(o, ['chord_basic_nashville'], maj),
  };
}

export function normalizeChordListFromClient(
  rawList: unknown,
  durationSec: number | undefined,
): TranscriptionChordEventSubdoc[] {
  if (!Array.isArray(rawList)) return [];
  const rough = rawList
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const o = r as Record<string, unknown>;
      const s = pickNum(o, ['start']);
      const e = pickNum(o, ['end']);
      if (s === undefined || e === undefined) return null;
      return { start: Math.max(0, s), end: Math.max(s, e) };
    })
    .filter((x): x is { start: number; end: number } => x != null);
  const bpm = estimateBpm(durationSec, rough);
  const out: TranscriptionChordEventSubdoc[] = [];
  for (const item of rawList) {
    const n = normalizeChordEventFromClient(item, bpm);
    if (n) out.push(n);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
