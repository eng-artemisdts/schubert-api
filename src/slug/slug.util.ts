import slugify from 'slugify';

/** Remove trechos entre parêntesis (ex.: feat., remix) antes do slug. */
export function stripParentheticalSegments(title: string): string {
  return title.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Gera um slug estável a partir do nome visível (título ou artista).
 * Usa `slugify` com strict + locale pt.
 */
export function slugFromDisplayName(title: string): string {
  const cleaned = stripParentheticalSegments(title);
  const base = slugify(cleaned, { lower: true, strict: true, locale: 'pt' });
  return base || 'faixa';
}
