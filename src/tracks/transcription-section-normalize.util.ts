import type { TranscriptionSectionSubdoc } from './schemas/track.schema';

function normalizeLabel(label: unknown): string {
  return typeof label === 'string' ? label.trim() || '—' : '—';
}

/**
 * Valida e ordena secções vindas do cliente (edição de cifra).
 */
export function normalizeSectionListFromClient(raw: unknown): TranscriptionSectionSubdoc[] {
  if (!Array.isArray(raw)) return [];
  const parsed: TranscriptionSectionSubdoc[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const start = Number(o.start);
    const end = Number(o.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    parsed.push({
      start,
      end: Math.max(start + 0.01, end),
      label: normalizeLabel(o.label),
    });
  }
  parsed.sort((a, b) => a.start - b.start);
  return parsed;
}
