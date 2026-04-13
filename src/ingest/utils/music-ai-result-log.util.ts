import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

import type { Logger } from '@nestjs/common';

const MAX_INLINE = 480;
const MAX_URL_PREVIEW = 160;

/** Resumo legível de um valor do `job.result` / `result.music-ai.json` (evita logs gigantes). */
export function summarizeMusicAiResultValue(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    const s = v;
    if (s.startsWith('http://') || s.startsWith('https://')) {
      return s.length > MAX_URL_PREVIEW
        ? `${s.slice(0, MAX_URL_PREVIEW)}… [url, ${s.length} chars]`
        : s;
    }
    return s.length > MAX_INLINE ? `${s.slice(0, MAX_INLINE)}… [${s.length} chars]` : s;
  }
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > MAX_INLINE ? `${s.slice(0, MAX_INLINE)}… [json ${s.length} chars]` : s;
    } catch {
      return '[object]';
    }
  }
  return String(v);
}

/** Chaves de `job.result` que normalmente apontam para o JSON de acordes (URL https completa nos logs). */
const CHORD_SOURCE_RESULT_KEYS = ['chords', 'Chords', 'chordMap', 'chordmap', 'chord_map'] as const;

/** Loga cada chave do `result` da API (URLs / strings antes do download local). */
export function logMusicAiApiResultPreview(
  logger: Logger,
  jobId: string,
  workflow: string,
  result: Record<string, unknown> | null | undefined,
): void {
  if (!result || typeof result !== 'object') {
    logger.log(`Music.AI [${jobId}] workflow=«${workflow}» job.result: (vazio ou inválido)`);
    return;
  }
  const lines = Object.entries(result).map(
    ([k, v]) => `  · ${k}: ${summarizeMusicAiResultValue(v)}`,
  );
  logger.log(
    `Music.AI [${jobId}] workflow=«${workflow}» job.result (${lines.length} campo(s)):\n${lines.join('\n')}`,
  );
  for (const key of CHORD_SOURCE_RESULT_KEYS) {
    const v = result[key];
    if (typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'))) {
      logger.log(`Music.AI URL completo (${key}, origem do chords.json): ${v}`);
    }
  }
}

/** Lista ficheiros na pasta do SDK após `downloadJobResults`. */
export function logMusicAiDownloadDirListing(logger: Logger, outDir: string): void {
  try {
    const names = readdirSync(outDir).sort();
    const lines = names.map((n) => {
      const p = join(outDir, n);
      const sz = existsSync(p) ? statSync(p).size : -1;
      return `  · ${n} (${sz} bytes)`;
    });
    logger.log(`Music.AI pasta após download (${outDir}):\n${lines.join('\n')}`);
  } catch (e) {
    logger.warn(`Music.AI: não foi possível listar a pasta de download: ${(e as Error).message}`);
  }
}

type MetaFileShape = {
  id?: string;
  name?: string;
  result?: Record<string, unknown>;
};

/** Conteúdo de `result.music-ai.json` com valores truncados (paths locais + URLs). */
export function logMusicAiResultJsonFile(logger: Logger, outDir: string): void {
  const metaPath = join(outDir, 'result.music-ai.json');
  if (!existsSync(metaPath)) {
    logger.warn(`Music.AI: ficheiro ausente: ${metaPath}`);
    return;
  }
  try {
    const raw = readFileSync(metaPath, 'utf8');
    const meta = JSON.parse(raw) as MetaFileShape;
    const result = meta.result;
    const preview: Record<string, string> = {};
    if (result && typeof result === 'object') {
      for (const [k, v] of Object.entries(result)) {
        preview[k] = summarizeMusicAiResultValue(v);
      }
    }
    const head = {
      id: meta.id,
      name: meta.name,
      resultKeys: result && typeof result === 'object' ? Object.keys(result) : [],
      result: preview,
    };
    logger.log(`Music.AI result.music-ai.json (resumo):\n${JSON.stringify(head, null, 2)}`);

    if (result && typeof result === 'object') {
      for (const key of CHORD_SOURCE_RESULT_KEYS) {
        const rel = result[key];
        if (typeof rel !== 'string' || !rel.endsWith('.json')) continue;
        const abs = isAbsolute(rel) ? rel : resolve(outDir, rel.replace(/^\.\//, ''));
        if (existsSync(abs)) {
          logger.log(`Music.AI caminho absoluto local (${key} → ficheiro descarregado): ${abs}`);
        }
      }
    }
  } catch (e) {
    logger.warn(`Music.AI: falha ao ler/parse result.music-ai.json: ${(e as Error).message}`);
  }
}
