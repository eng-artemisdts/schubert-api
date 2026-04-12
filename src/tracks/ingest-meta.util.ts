import { BadRequestException } from '@nestjs/common';

import type { RecognizedSongDto } from '../integrations/music-recognition/recognized-song.dto';

/**
 * Interpreta o campo multipart `meta` (JSON) com o mesmo formato que `song` em `POST /tracks/identify`.
 */
export function parseIngestMetaField(raw: unknown): RecognizedSongDto | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') {
    return null;
  }

  let v: unknown;
  try {
    v = JSON.parse(s) as unknown;
  } catch {
    throw new BadRequestException('O campo meta deve ser JSON válido.');
  }

  if (typeof v !== 'object' || v === null) {
    throw new BadRequestException('meta deve ser um objeto JSON.');
  }

  const o = v as Record<string, unknown>;
  if (typeof o.title !== 'string' || !o.title.trim()) {
    throw new BadRequestException('meta.title é obrigatório.');
  }
  if (typeof o.artist !== 'string' || !o.artist.trim()) {
    throw new BadRequestException('meta.artist é obrigatório.');
  }

  const spotifyArtistIds = Array.isArray(o.spotify_artist_ids)
    ? o.spotify_artist_ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];

  const out: RecognizedSongDto = {
    title: o.title.trim(),
    artist: o.artist.trim(),
    album: typeof o.album === 'string' ? o.album : '',
    release_date: typeof o.release_date === 'string' ? o.release_date : '',
    label: typeof o.label === 'string' ? o.label : '',
    timecode: typeof o.timecode === 'string' ? o.timecode : '',
    song_link: typeof o.song_link === 'string' ? o.song_link : '',
    spotify_artist_ids: spotifyArtistIds,
  };

  if (typeof o.spotify_track_id === 'string' && o.spotify_track_id.trim()) {
    out.spotify_track_id = o.spotify_track_id.trim();
  }
  if (typeof o.duration_ms === 'number' && Number.isFinite(o.duration_ms)) {
    out.duration_ms = o.duration_ms;
  }
  if (typeof o.cover_image_url === 'string' && o.cover_image_url.trim()) {
    out.cover_image_url = o.cover_image_url.trim();
  }

  return out;
}
