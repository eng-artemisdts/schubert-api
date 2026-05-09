export type SourcePlatform = 'youtube' | 'spotify' | 'tiktok' | 'instagram' | 'unknown';

export function detectSourcePlatform(url: string): SourcePlatform {
  const u = url.toLowerCase().trim();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('spotify.com')) return 'spotify';
  if (u.includes('tiktok.com') || u.includes('vm.tiktok.com')) return 'tiktok';
  if (u.includes('instagram.com') || u.includes('instagr.am')) return 'instagram';
  return 'unknown';
}
