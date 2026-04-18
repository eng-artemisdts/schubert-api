import { BadRequestException } from '@nestjs/common';

import type { RecognizedSongDto } from '../integrations/music-recognition/recognized-song.dto';
import type { MusicTranscriptionMetaSubdoc } from '../tracks/schemas/track.schema';

export type ParsedIngestMeta = {
  song: RecognizedSongDto | null;
  transcriptionMeta: MusicTranscriptionMetaSubdoc | null;
};

function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, unknown>;
}

function readTranscriptionMeta(o: Record<string, unknown>): MusicTranscriptionMetaSubdoc | null {
  const meta: MusicTranscriptionMetaSubdoc = {};
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : undefined);
  const num = (k: string) =>
    typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? (o[k] as number) : undefined;

  const id = str('id');
  const name = str('name');
  const sourcePathParam = str('sourcePathParam');
  const trackId = str('trackId');
  const audioUrl = str('audioUrl');
  const duration_seconds = num('duration_seconds');

  if (id) meta.id = id;
  if (name) meta.name = name;
  if (sourcePathParam) meta.sourcePathParam = sourcePathParam;
  if (trackId) meta.trackId = trackId;
  if (audioUrl) meta.audioUrl = audioUrl;
  if (duration_seconds !== undefined) meta.duration_seconds = duration_seconds;

  return Object.keys(meta).length ? meta : null;
}

function readRecognizedSong(o: Record<string, unknown>): RecognizedSongDto | null {
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const artist = typeof o.artist === 'string' ? o.artist.trim() : '';
  if (!title || !artist) return null;

  const spotifyArtistIds = Array.isArray(o.spotify_artist_ids)
    ? o.spotify_artist_ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];

  const out: RecognizedSongDto = {
    title,
    artist,
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

/**
 * Interpreta `meta` (string JSON ou objeto já parseado pelo Multer).
 * Aceita o payload AudD (`RecognizedSongDto`) e/ou campos de `MusicTranscriptionMetaSubdoc`.
 */
export function parseIngestMultipartMeta(raw: unknown): ParsedIngestMeta {
  if (raw === undefined || raw === null) {
    return { song: null, transcriptionMeta: null };
  }

  let obj: unknown;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return { song: null, transcriptionMeta: null };
    try {
      obj = JSON.parse(s) as unknown;
    } catch {
      throw new BadRequestException('O campo meta deve ser JSON válido.');
    }
  } else if (typeof raw === 'object') {
    obj = raw;
  } else {
    throw new BadRequestException('meta inválido.');
  }

  const o = asRecord(obj);
  return {
    song: readRecognizedSong(o),
    transcriptionMeta: readTranscriptionMeta(o),
  };
}
