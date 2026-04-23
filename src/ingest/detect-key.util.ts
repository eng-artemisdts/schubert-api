import { Chord, Key } from 'tonal';

import type { TranscriptionChordEventSubdoc } from '../tracks/schemas/track.schema';

const TONICS = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'F#',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
] as const;

export type DetectedKey = {
  /** Texto humano (ex.: «G major», «E minor»). */
  key: string;
  tonic: string;
  type: 'major' | 'minor';
  /** Acordes únicos reconhecidos do total (sem N.C. / duplicados). */
  score: number;
  total: number;
};

/**
 * Extrai a tónica (ex.: `C#`, `Db`, `A`) de um símbolo de acorde usando `tonal`,
 * com fallback por regex compatível com Music.AI / cifras populares.
 */
function extractRoot(symbol: string): string | null {
  const raw = symbol?.trim();
  if (!raw) return null;
  if (raw === 'N.C.' || raw.toUpperCase() === 'NC') return null;
  const beforeSlash = raw.split('/')[0].trim();
  const parsed = Chord.get(beforeSlash);
  if (
    parsed &&
    !parsed.empty &&
    typeof parsed.tonic === 'string' &&
    parsed.tonic
  ) {
    return parsed.tonic;
  }
  const match = beforeSlash.match(/^[A-G](b|#)?/);
  return match ? match[0] : null;
}

/** Heurística: é um acorde menor (detetado via tipo tonal ou sufixo explícito). */
function isMinorQuality(symbol: string): boolean {
  const parsed = Chord.get(symbol.split('/')[0].trim());
  if (!parsed.empty && parsed.quality) {
    if (parsed.quality === 'Minor') return true;
    if (parsed.quality === 'Diminished') return true;
  }
  // fallback: m imediatamente após a tónica (evita `maj`).
  return /^[A-G](b|#)?m(?!aj)/.test(symbol);
}

function diatonicTriadsFor(tonic: string, type: 'major' | 'minor'): string[] {
  if (type === 'major') return Key.majorKey(tonic).triads.filter(Boolean);
  return Key.minorKey(tonic).natural.triads.filter(Boolean);
}

type ParsedChord = { symbol: string; root: string; minor: boolean };

function parseSymbols(symbols: string[]): {
  parsed: ParsedChord[];
  unique: ParsedChord[];
} {
  const parsed: ParsedChord[] = [];
  for (const s of symbols) {
    if (typeof s !== 'string') continue;
    const clean = s.trim();
    if (!clean || clean === 'N.C.' || clean.toUpperCase() === 'NC') continue;
    const root = extractRoot(clean);
    if (!root) continue;
    parsed.push({ symbol: clean, root, minor: isMinorQuality(clean) });
  }
  const seen = new Set<string>();
  const unique: ParsedChord[] = [];
  for (const p of parsed) {
    const k = `${p.root}|${p.minor}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(p);
  }
  return { parsed, unique };
}

/**
 * Pontua cada combinação (tónica × modo) pelo nº de acordes únicos que pertencem à escala.
 * Segue a abordagem do exemplo: compara a tónica do acorde com a tónica dos acordes diatónicos
 * e exige correspondência maior/menor básica para evitar falsos positivos entre tons homónimos.
 */
export function detectKeyFromChordSymbols(
  symbols: string[],
): DetectedKey | null {
  const { parsed, unique } = parseSymbols(symbols);
  if (!unique.length) return null;

  const first = parsed[0];
  const last = parsed[parsed.length - 1];

  type Scored = DetectedKey & {
    tonicInFirstOrLast: number;
    tonicAnywhere: number;
  };
  let best: Scored | null = null;

  for (const tonic of TONICS) {
    for (const type of ['major', 'minor'] as const) {
      const triads = diatonicTriadsFor(tonic, type);
      if (!triads.length) continue;

      let score = 0;
      for (const { root, minor } of unique) {
        const match = triads.some((triad) => {
          const tRoot = extractRoot(triad);
          if (!tRoot || tRoot !== root) return false;
          return isMinorQuality(triad) === minor;
        });
        if (match) score++;
      }
      if (score === 0) continue;

      const targetMinor = type === 'minor';
      const tonicAnywhere = unique.some(
        (u) => u.root === tonic && u.minor === targetMinor,
      )
        ? 1
        : 0;
      let tonicInFirstOrLast = 0;
      if (first && first.root === tonic && first.minor === targetMinor)
        tonicInFirstOrLast += 1;
      if (last && last.root === tonic && last.minor === targetMinor)
        tonicInFirstOrLast += 1;

      const candidate: Scored = {
        key: `${tonic} ${type}`,
        tonic,
        type,
        score,
        total: unique.length,
        tonicInFirstOrLast,
        tonicAnywhere,
      };

      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.score !== best.score) {
        if (candidate.score > best.score) best = candidate;
        continue;
      }
      // Desempate: começar/terminar na tónica é um forte indicador do tom real.
      if (candidate.tonicInFirstOrLast !== best.tonicInFirstOrLast) {
        if (candidate.tonicInFirstOrLast > best.tonicInFirstOrLast)
          best = candidate;
        continue;
      }
      if (candidate.tonicAnywhere !== best.tonicAnywhere) {
        if (candidate.tonicAnywhere > best.tonicAnywhere) best = candidate;
      }
    }
  }

  if (!best) return null;
  return {
    key: best.key,
    tonic: best.tonic,
    type: best.type,
    score: best.score,
    total: best.total,
  };
}

/** Açúcar: recebe os subdocumentos de acorde e devolve a string final para `original_tune`. */
export function detectOriginalTuneFromChords(
  chords: Pick<TranscriptionChordEventSubdoc, 'chord_majmin'>[],
): string {
  const symbols = chords
    .map((c) => (typeof c?.chord_majmin === 'string' ? c.chord_majmin : ''))
    .filter((s) => s);
  const detected = detectKeyFromChordSymbols(symbols);
  return detected ? detected.key : '';
}
