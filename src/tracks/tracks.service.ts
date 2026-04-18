import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Artist, ArtistDocument } from '../artists/schemas/artist.schema';
import { RecognizedSongDto } from '../integrations/music-recognition/recognized-song.dto';
import type {
  LyricsSource,
  TranscriptionLyricSegmentSubdoc,
} from './schemas/track.schema';
import { Track, TrackDocument } from './schemas/track.schema';
import { normalizeChordListFromClient } from './transcription-chord-normalize.util';
import { normalizeSectionListFromClient } from './transcription-section-normalize.util';

export type TranscriptionPatchBody = {
  chords?: unknown;
  lyrics?: unknown;
  lyricsSource?: LyricsSource;
  sections?: unknown;
};

@Injectable()
export class TracksService {
  constructor(
    @InjectModel(Track.name) private readonly trackModel: Model<TrackDocument>,
    @InjectModel(Artist.name)
    private readonly artistModel: Model<ArtistDocument>,
  ) {}

  /**
   * Resolves a DB track already configured for the app, using recognition metadata.
   * Order: Spotify track id → primary Spotify artist id + normalized track name.
   */
  async findConfiguredTrackForRecognition(
    song: RecognizedSongDto,
  ): Promise<TrackDocument | null> {
    if (song.spotify_track_id) {
      const bySpotify = await this.trackModel
        .findOne({ spotifyId: song.spotify_track_id })
        .populate('artistId')
        .exec();
      if (bySpotify) return bySpotify;
    }

    const primaryArtistSpotifyId = song.spotify_artist_ids[0];
    if (primaryArtistSpotifyId && song.title?.trim()) {
      const artist = await this.artistModel
        .findOne({ spotifyId: primaryArtistSpotifyId })
        .exec();
      if (artist) {
        const escaped = escapeRegex(song.title.trim());
        const byName = await this.trackModel
          .findOne({
            artistId: artist._id,
            name: new RegExp(`^${escaped}$`, 'i'),
          })
          .populate('artistId')
          .exec();
        if (byName) return byName;
      }
    }

    return null;
  }

  /**
   * Resolve uma faixa persistida por `trackId` (pasta media/transcriptions) ou `spotifyId`.
   */
  async findByPublicKey(key: string): Promise<TrackDocument | null> {
    const trimmed = key.trim();
    if (!trimmed) return null;
    return this.trackModel
      .findOne({
        $or: [{ trackId: trimmed }, { spotifyId: trimmed }],
      })
      .populate('artistId')
      .exec();
  }

  /**
   * Resolve por slugs do artista e da faixa (`/cifras/:artistSlug/:songSlug`).
   */
  async findByArtistAndSongSlugs(
    artistSlug: string,
    songSlug: string,
  ): Promise<TrackDocument | null> {
    const a = artistSlug.trim().toLowerCase();
    const s = songSlug.trim().toLowerCase();
    if (!a || !s) return null;
    const artist = await this.artistModel.findOne({ slug: a }).exec();
    if (!artist) return null;
    return this.trackModel
      .findOne({ artistId: artist._id, slug: s })
      .populate('artistId')
      .exec();
  }

  /**
   * Atualiza acordes, letra (`lyrics` / `lyricsSource`) e/ou secções; só o dono (`owner` ou `userId`) pode gravar.
   */
  async updateTranscriptionByPublicKey(
    key: string,
    ownerSub: string,
    body: TranscriptionPatchBody,
  ): Promise<TrackDocument> {
    const track = await this.findByPublicKey(key);
    if (!track) {
      throw new NotFoundException(`Nenhuma faixa com a chave «${key}».`);
    }
    this.assertTrackOwner(track, ownerSub);
    await this.applyTranscriptionPatch(track, body);
    await track.save();
    const fresh = await this.findByPublicKey(key);
    if (!fresh) {
      throw new NotFoundException(`Faixa «${key}» não encontrada após atualização.`);
    }
    return fresh;
  }

  async updateTranscriptionBySlugs(
    artistSlug: string,
    songSlug: string,
    ownerSub: string,
    body: TranscriptionPatchBody,
  ): Promise<TrackDocument> {
    const track = await this.findByArtistAndSongSlugs(artistSlug, songSlug);
    if (!track) {
      throw new NotFoundException(
        `Nenhuma faixa com os slugs «${artistSlug}» / «${songSlug}».`,
      );
    }
    this.assertTrackOwner(track, ownerSub);
    await this.applyTranscriptionPatch(track, body);
    await track.save();
    const fresh = await this.findByArtistAndSongSlugs(artistSlug, songSlug);
    if (!fresh) {
      throw new NotFoundException(`Faixa não encontrada após atualização.`);
    }
    return fresh;
  }

  private assertTrackOwner(track: TrackDocument, ownerSub: string): void {
    const owner = (track as unknown as { owner?: string }).owner;
    const uid = track.userId;
    const allowed =
      (typeof owner === 'string' && owner === ownerSub) ||
      (typeof uid === 'string' && uid === ownerSub);
    if (!allowed) {
      throw new ForbiddenException('Sem permissão para editar esta faixa.');
    }
  }

  private async applyTranscriptionPatch(
    track: TrackDocument,
    body: TranscriptionPatchBody,
  ): Promise<void> {
    if (body.chords !== undefined) {
      const durationSec = track.meta?.duration_seconds;
      track.chords = normalizeChordListFromClient(body.chords, durationSec);
      track.markModified('chords');
    }

    if (body.lyrics !== undefined) {
      track.lyrics = body.lyrics as TranscriptionLyricSegmentSubdoc[];
      track.markModified('lyrics');
    }

    if (body.lyricsSource !== undefined) {
      track.lyricsSource = body.lyricsSource;
      track.markModified('lyricsSource');
    }

    if (body.sections !== undefined) {
      track.sections = normalizeSectionListFromClient(body.sections);
      track.markModified('sections');
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
