import { Injectable, Logger } from '@nestjs/common';
import { fetch } from 'undici';

import type { TranscriptionLyricSegmentSubdoc } from '../../tracks/schemas/track.schema';
import type { ILyricsSearchProvider, LrclibSearchInput, LyricsMatchResult } from '../domain/lyrics-search.port';
import {
  lrcSyncedTextToSegments,
  plainLyricsToSingleSegment,
} from '../mappers/lrclib-to-segments.mapper';

const LRCLIB_BASE = 'https://lrclib.net/api';

type LrcLibRecord = {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
};

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(feat|ft|featuring|remix|edit|version|radio)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeForMatch(text).split(' ').filter(Boolean));
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / Math.max(a.size, b.size);
}

function cleanupLrcLyrics(input: string): string {
  return input
    .replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]\s*/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pickLrcLibLyrics(rec: LrcLibRecord): string {
  const raw = (rec.plainLyrics || rec.syncedLyrics || '').trim();
  return cleanupLrcLyrics(raw);
}

@Injectable()
export class LrclibLyricsSearchProvider implements ILyricsSearchProvider {
  private readonly logger = new Logger(LrclibLyricsSearchProvider.name);

  async search(input: LrclibSearchInput): Promise<LyricsMatchResult | null> {
    const durationSec = input.durationSec;
    const getParams = new URLSearchParams({
      track_name: input.title,
      artist_name: input.artist,
    });
    if (input.album) getParams.set('album_name', input.album);
    if (durationSec && durationSec > 0) {
      getParams.set('duration', String(Math.round(durationSec)));
    }

    try {
      const directRes = await fetch(`${LRCLIB_BASE}/get?${getParams}`);
      if (directRes.ok) {
        const rec = (await directRes.json()) as LrcLibRecord;
        const built = this.recordToMatch(rec, durationSec);
        if (built) {
          this.logger.log(`LRCLIB hit /get: "${input.title}" — ${input.artist}`);
          return built;
        }
      }
    } catch (e) {
      this.logger.warn(`LRCLIB /get falhou: ${(e as Error).message}`);
    }

    const searchParams = new URLSearchParams({
      track_name: input.title,
      artist_name: input.artist,
    });
    const searchRes = await fetch(`${LRCLIB_BASE}/search?${searchParams}`);
    if (!searchRes.ok) return null;

    const rows = ((await searchRes.json()) as LrcLibRecord[]).filter(
      (r) => !r.instrumental && (r.plainLyrics || r.syncedLyrics),
    );
    if (!rows.length) return null;

    const songTitleTokens = tokenSet(input.title);
    const songArtistTokens = tokenSet(input.artist);

    const ranked = rows
      .map((r) => {
        const titleScore = overlapScore(songTitleTokens, tokenSet(r.trackName ?? ''));
        const artistScore = overlapScore(songArtistTokens, tokenSet(r.artistName ?? ''));
        const durationScore =
          durationSec && durationSec > 0 && typeof r.duration === 'number' && r.duration > 0
            ? 1 -
              Math.min(1, Math.abs(r.duration - durationSec) / Math.max(8, durationSec * 0.1))
            : 0.5;
        const score = titleScore * 0.5 + artistScore * 0.35 + durationScore * 0.15;
        return { r, score };
      })
      .sort((a, b) => b.score - a.score);

    const best = ranked[0]?.r;
    if (!best) return null;
    const built = this.recordToMatch(best, durationSec);
    if (built) this.logger.log(`LRCLIB hit /search: "${input.title}" — ${input.artist}`);
    return built;
  }

  private recordToMatch(rec: LrcLibRecord, durationSec?: number): LyricsMatchResult | null {
    if (rec.instrumental) return null;
    const raw = pickLrcLibLyrics(rec);
    if (!raw) return null;
    let segments: TranscriptionLyricSegmentSubdoc[] = [];
    if (rec.syncedLyrics?.trim()) {
      segments = lrcSyncedTextToSegments(rec.syncedLyrics, durationSec);
    }
    if (!segments.length) {
      segments = plainLyricsToSingleSegment(raw);
    }
    if (!segments.length) return null;
    return { segments };
  }
}
