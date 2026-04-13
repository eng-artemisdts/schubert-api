import { existsSync, readFileSync, readdirSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

import type {
  TranscriptionChordEventSubdoc,
  TranscriptionSectionSubdoc,
} from '../../tracks/schemas/track.schema';

function isChordEvent(x: unknown): x is TranscriptionChordEventSubdoc {
  return !!x && typeof x === 'object' && 'start' in x && 'chord_majmin' in x;
}

function isLikelyChordRow(x: unknown): boolean {
  return !!x && typeof x === 'object' && 'chord_majmin' in (x as object);
}

/** Raiz array OU `{ chords: [...] }` / `chordMap` (output combinado do workflow). */
function extractChordsFromRaw(raw: unknown): TranscriptionChordEventSubdoc[] {
  if (Array.isArray(raw)) return raw.filter(isChordEvent);
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const k of ['chords', 'chordMap', 'chordmap', 'chord_map', 'events', 'chordEvents']) {
      const inner = o[k];
      if (Array.isArray(inner)) {
        const c = inner.filter(isChordEvent);
        if (c.length) return c;
      }
    }
  }
  return [];
}

function pickNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
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

function pickSectionLabel(o: Record<string, unknown>): string | undefined {
  const keys = [
    'label',
    'name',
    'type',
    'section',
    'section_name',
    'sectionName',
    'sectionType',
    'section_type',
    'kind',
    'category',
    'descriptor',
    'title',
    'role',
    'part',
    'text',
  ];
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Converte linhas típicas do Music.AI / workflows para o subdocumento `sections` do Track. */
export function normalizeMusicAiSection(x: unknown): TranscriptionSectionSubdoc | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const start = pickNumber(o, ['start', 'start_time', 'begin', 'from', 't_start', 'time']);
  const end = pickNumber(o, ['end', 'end_time', 'finish', 'to', 't_end']);
  const label = pickSectionLabel(o) ?? 'Section';
  if (start === undefined || end === undefined) return null;
  return { start, end, label };
}

function extractSectionsFromRaw(raw: unknown): TranscriptionSectionSubdoc[] {
  if (Array.isArray(raw)) {
    if (raw.length > 0 && raw.every(isLikelyChordRow)) {
      return [];
    }
    return raw
      .map(normalizeMusicAiSection)
      .filter((s): s is TranscriptionSectionSubdoc => s != null);
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const nestedKeys = [
      'sections',
      'section',
      'structure',
      'songSections',
      'song_sections',
      'segments',
      'items',
      'data',
      'song_structure',
      'songStructure',
      'phrase_structure',
      'phrases',
      'timeline',
    ];
    for (const nk of nestedKeys) {
      const inner = o[nk];
      if (Array.isArray(inner)) {
        const secs = extractSectionsFromRaw(inner);
        if (secs.length) return secs;
      }
    }
  }
  return [];
}

/** Chaves comuns em `job.result` / `result.music-ai.json` → ficheiro JSON de secções (workflow-dependent). */
const SECTION_RESULT_KEYS = [
  /** Nome do output no módulo Sections da Music.AI (timeline / JSON). */
  'sectionsMap',
  'sections_map',
  'SectionsMap',
  'sections',
  'Sections',
  'structure',
  'Structure',
  'song_structure',
  'songStructure',
  'phrase_structure',
  'phrases',
  'phraseSegments',
  'phrase_segments',
  'section_map',
  'sectionMap',
  'musical_structure',
  'segments',
  'Segments',
  'form',
  'Form',
];

const CHORD_RESULT_KEYS = new Set([
  'chords',
  'Chords',
  'chordMap',
  'chordmap',
  'chord_map',
  'chord_map_json',
]);

function readResolvedJsonFile(dir: string, rel: string): unknown | null {
  if (typeof rel !== 'string' || !rel.endsWith('.json')) return null;
  const abs = isAbsolute(rel) ? rel : resolve(dir, rel.replace(/^\.\//, ''));
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

const INLINE_TUNE_KEYS = [
  'original_tune',
  'originalTune',
  'key',
  'tonality',
  'tuning',
  'detected_key',
  'detectedKey',
  'musical_key',
  'musicalKey',
  'root_key',
  'rootKey',
  'key_signature',
  'keySignature',
] as const;

function pickInlineTuneString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t || t.startsWith('http') || t.startsWith('./')) return undefined;
  return t;
}

/** Valores de tonalidade no objeto `result` do job (strings inline, não URLs). */
function pickOriginalTuneFromResult(result: Record<string, unknown>): string | undefined {
  for (const k of INLINE_TUNE_KEYS) {
    const t = pickInlineTuneString(result[k]);
    if (t) return t;
  }
  return undefined;
}

/** Objetos JSON descarregados (meta, info, etc.) com campos típicos de tonalidade. */
function pickOriginalTuneFromJsonObject(raw: unknown, depth = 0): string | undefined {
  if (depth > 10) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  for (const k of INLINE_TUNE_KEYS) {
    const t = pickInlineTuneString(o[k]);
    if (t) return t;
  }
  const nested = o.result ?? o.metadata ?? o.meta;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return pickOriginalTuneFromJsonObject(nested, depth + 1);
  }
  return undefined;
}

const TUNE_JSON_RESULT_KEY_HINT =
  /tune|tonal|key|meta|info|music|song|analysis|chord|detect/i;

/**
 * Procura tonalidade em ficheiros `.json` referenciados no `result` (ex.: `./analysis.json`).
 */
function tryPickOriginalTuneFromReferencedJsons(
  dir: string,
  result: Record<string, unknown>,
): string | undefined {
  const entries = Object.entries(result).sort(([a], [b]) => {
    const score = (k: string) => (TUNE_JSON_RESULT_KEY_HINT.test(k) ? 0 : 1);
    return score(a) - score(b);
  });
  for (const [, val] of entries) {
    if (typeof val !== 'string' || !val.endsWith('.json')) continue;
    const raw = readResolvedJsonFile(dir, val);
    if (raw == null) continue;
    const t = pickOriginalTuneFromJsonObject(raw);
    if (t) return t;
  }
  return undefined;
}

function tryPickOriginalTuneFromExportDirFiles(dir: string): string | undefined {
  for (const name of ['meta.json', 'music-ai-meta.json', 'analysis.json', 'info.json', 'tuning.json']) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
      const t = pickOriginalTuneFromJsonObject(raw);
      if (t) return t;
    } catch {
      /* skip */
    }
  }
  return undefined;
}

/**
 * Percorre todas as entradas `result` que apontam para `./*.json`, ignora ficheiros claramente de acordes,
 * e tenta extrair secções (útil quando o slug do workflow usa um nome de output não listado).
 */
/** Não confundir `transcription` (estrutura/letra) com `transcript` sozinho. */
function isLikelyLyricsOrAlignmentResultKey(key: string): boolean {
  const k = key.toLowerCase();
  if (/\b(lyrics?|alignment|lrc|vocal|stem|midi)\b/i.test(k)) return true;
  if (/\btranscript\b/i.test(k) && !/transcription/i.test(k)) return true;
  if (/\bword_?level\b/i.test(k)) return true;
  return false;
}

function tryLoadSectionsFromAnyResultJson(
  dir: string,
  result: Record<string, unknown>,
): TranscriptionSectionSubdoc[] {
  for (const [key, val] of Object.entries(result)) {
    if (typeof val !== 'string' || !val.endsWith('.json')) continue;
    if (CHORD_RESULT_KEYS.has(key)) continue;
    if (isLikelyLyricsOrAlignmentResultKey(key)) continue;
    const raw = readResolvedJsonFile(dir, val);
    if (raw == null) continue;
    const secs = extractSectionsFromRaw(raw);
    if (secs.length) {
      return secs;
    }
  }
  return [];
}

/**
 * Ficheiros JSON na pasta do job que não estão listados em `result` (alguns workflows gravam outputs extra).
 */
function tryLoadSectionsFromLooseDirJson(dir: string): TranscriptionSectionSubdoc[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names.filter((n) => n.endsWith('.json') && n !== 'result.music-ai.json').sort()) {
    const lower = name.toLowerCase();
    if (lower === 'chords.json' || lower === 'chordmap.json') continue;
    if (/chord/.test(lower) && !/section|structure|phrase|song|segment|timeline|form/.test(lower)) {
      continue;
    }
    const raw = readResolvedJsonFile(dir, `./${name}`);
    if (raw == null) continue;
    const secs = extractSectionsFromRaw(raw);
    if (secs.length) return secs;
  }
  return [];
}

/** Chaves do objeto `result` em `result.music-ai.json` (útil para logs / workflows desconhecidos). */
export function readMusicAiResultKeys(outDir: string): string[] {
  const metaPath = join(outDir, 'result.music-ai.json');
  if (!existsSync(metaPath)) return [];
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as MusicAiResultFile;
    const r = meta.result;
    return r && typeof r === 'object' ? Object.keys(r) : [];
  } catch {
    return [];
  }
}

/** Carrega `chords.json` e/ou `sections.json` de uma pasta de export Music.AI. */
export function tryLoadMusicAiExportFromDir(
  dir: string,
): {
  chords: TranscriptionChordEventSubdoc[];
  sections: TranscriptionSectionSubdoc[];
  original_tune: string;
} | null {
  const chordsPath = join(dir, 'chords.json');
  const sectionsPath = join(dir, 'sections.json');
  if (!existsSync(chordsPath) && !existsSync(sectionsPath)) return null;
  try {
    let chords: TranscriptionChordEventSubdoc[] = [];
    let sections: TranscriptionSectionSubdoc[] = [];
    if (existsSync(chordsPath)) {
      const chordsRaw = JSON.parse(readFileSync(chordsPath, 'utf8')) as unknown;
      chords = extractChordsFromRaw(chordsRaw);
      sections = extractSectionsFromRaw(chordsRaw);
    }
    if (existsSync(sectionsPath)) {
      const sectionsRaw = JSON.parse(readFileSync(sectionsPath, 'utf8')) as unknown;
      const fromFile = extractSectionsFromRaw(sectionsRaw);
      if (fromFile.length) sections = fromFile;
    }
    if (!chords.length && !sections.length) return null;
    const original_tune = tryPickOriginalTuneFromExportDirFiles(dir) ?? '';
    return { chords, sections, original_tune };
  } catch {
    return null;
  }
}

type MusicAiResultFile = {
  result?: Record<string, unknown>;
};

/**
 * Após `downloadJobResults` do SDK: lê `result.music-ai.json` e resolve ficheiros referenciados
 * (ex.: `chords` → `./chords.json`) quando os nomes na raiz da pasta não são os esperados.
 */
export function tryLoadMusicAiSdkOutputDir(
  dir: string,
): {
  chords: TranscriptionChordEventSubdoc[];
  sections: TranscriptionSectionSubdoc[];
  original_tune: string;
} | null {
  const direct = tryLoadMusicAiExportFromDir(dir);
  if (direct?.chords?.length || direct?.sections?.length) return direct;

  const metaPath = join(dir, 'result.music-ai.json');
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as MusicAiResultFile;
    const result = meta.result;
    if (!result || typeof result !== 'object') return null;

    let original_tune =
      pickOriginalTuneFromResult(result) ??
      tryPickOriginalTuneFromReferencedJsons(dir, result) ??
      '';

    let chords: TranscriptionChordEventSubdoc[] = [];
    let sections: TranscriptionSectionSubdoc[] = [];

    for (const ck of ['chords', 'Chords', 'chordMap', 'chordmap', 'chord_map'] as const) {
      const rel = result[ck];
      if (typeof rel !== 'string' || !rel.endsWith('.json')) continue;
      const raw = readResolvedJsonFile(dir, rel);
      if (raw == null) continue;
      const c = extractChordsFromRaw(raw);
      if (c.length) {
        chords = c;
        sections = extractSectionsFromRaw(raw);
        if (!original_tune) {
          const t = pickOriginalTuneFromJsonObject(raw);
          if (t) original_tune = t;
        }
        break;
      }
    }

    if (!sections.length) {
      for (const key of SECTION_RESULT_KEYS) {
        const rel = result[key];
        if (typeof rel !== 'string' || !rel.endsWith('.json')) continue;
        const raw = readResolvedJsonFile(dir, rel);
        if (raw == null) continue;
        sections = extractSectionsFromRaw(raw);
        if (sections.length) break;
      }
    }

    if (!sections.length) {
      sections = tryLoadSectionsFromAnyResultJson(dir, result);
    }

    if (!sections.length) {
      sections = tryLoadSectionsFromLooseDirJson(dir);
    }

    if (!chords.length && !sections.length) return null;
    return { chords, sections, original_tune };
  } catch {
    return null;
  }
}
