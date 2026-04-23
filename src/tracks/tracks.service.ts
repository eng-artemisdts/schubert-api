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
  variationLabel?: unknown;
  is_private?: unknown;
};

export type TrackWithVariations = {
  track: TrackDocument;
  variations: TrackDocument[];
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
  async findByPublicKey(
    key: string,
    viewerSub?: string,
  ): Promise<TrackDocument | null> {
    const trimmed = key.trim();
    if (!trimmed) return null;
    const direct = await this.trackModel
      .findOne({
        $or: [{ trackId: trimmed }, { spotifyId: trimmed }],
      })
      .populate('artistId')
      .exec();
    if (!direct) return null;
    if (!this.canViewerReadVariation(direct, viewerSub)) return null;
    const variationKey = (direct as unknown as { variationKey?: string })
      .variationKey;
    if (variationKey && variationKey !== '__base__') {
      return direct;
    }
    return this.resolvePreferredTrack(direct, viewerSub);
  }

  /**
   * Resolve por slugs do artista e da faixa (`/cifras/:artistSlug/:songSlug`).
   */
  async findByArtistAndSongSlugs(
    artistSlug: string,
    songSlug: string,
    viewerSub?: string,
  ): Promise<TrackDocument | null> {
    const a = artistSlug.trim().toLowerCase();
    const s = songSlug.trim().toLowerCase();
    if (!a || !s) return null;
    const artist = await this.artistModel.findOne({ slug: a }).exec();
    if (!artist) return null;
    const base = await this.trackModel
      .findOne({ artistId: artist._id, slug: s, variationKey: '__base__' })
      .populate('artistId')
      .exec();
    if (base) {
      return this.resolvePreferredTrack(base, viewerSub);
    }
    const fallback = await this.trackModel
      .findOne({ artistId: artist._id, slug: s })
      .sort({ createdAt: 1, _id: 1 })
      .populate('artistId')
      .exec();
    if (!fallback) return null;
    return this.resolvePreferredTrack(fallback, viewerSub);
  }

  async findTrackAndVariationsBySlugs(
    artistSlug: string,
    songSlug: string,
    viewerSub?: string,
  ): Promise<TrackWithVariations | null> {
    const preferred = await this.findByArtistAndSongSlugs(
      artistSlug,
      songSlug,
      viewerSub,
    );
    if (!preferred) return null;
    const baseTrackId = this.resolveBaseTrackId(preferred);
    const rawVariations = await this.trackModel
      .find({ variationOfTrackId: baseTrackId })
      .sort({ updatedAt: -1, _id: -1 })
      .populate('artistId')
      .exec();
    const variations = rawVariations.filter((doc) =>
      this.canViewerReadVariation(doc, viewerSub),
    );
    return { track: preferred, variations };
  }

  /**
   * Atualiza acordes, letra (`lyrics` / `lyricsSource`) e/ou secções; só o dono (`owner` ou `userId`) pode gravar.
   */
  async updateTranscriptionByPublicKey(
    key: string,
    ownerSub: string,
    body: TranscriptionPatchBody,
  ): Promise<TrackDocument> {
    const track = await this.findByPublicKey(key, ownerSub);
    if (!track) {
      throw new NotFoundException(`Nenhuma faixa com a chave «${key}».`);
    }
    this.assertTrackOwner(track, ownerSub);
    await this.applyTranscriptionPatch(track, body);
    await track.save();
    const fresh = await this.findByPublicKey(key, ownerSub);
    if (!fresh) {
      throw new NotFoundException(
        `Faixa «${key}» não encontrada após atualização.`,
      );
    }
    return fresh;
  }

  async updateTranscriptionBySlugs(
    artistSlug: string,
    songSlug: string,
    ownerSub: string,
    body: TranscriptionPatchBody,
  ): Promise<TrackDocument> {
    const track = await this.findByArtistAndSongSlugs(
      artistSlug,
      songSlug,
      ownerSub,
    );
    if (!track) {
      throw new NotFoundException(
        `Nenhuma faixa com os slugs «${artistSlug}» / «${songSlug}».`,
      );
    }
    this.assertTrackOwner(track, ownerSub);
    await this.applyTranscriptionPatch(track, body);
    await track.save();
    const fresh = await this.findByArtistAndSongSlugs(
      artistSlug,
      songSlug,
      ownerSub,
    );
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

    const isVariationDoc = Boolean(
      (
        track as unknown as { variationOfTrackId?: string }
      ).variationOfTrackId?.trim(),
    );
    if (body.variationLabel !== undefined && isVariationDoc) {
      const raw = body.variationLabel;
      const next =
        raw === null || raw === ''
          ? ''
          : typeof raw === 'string'
            ? raw.trim().slice(0, 120)
            : '';
      (track as unknown as { variationLabel?: string }).variationLabel = next;
      track.markModified('variationLabel');
    }

    if (body.is_private !== undefined && isVariationDoc) {
      const v = body.is_private;
      (track as unknown as { is_private?: boolean }).is_private =
        v === true || v === 'true';
      track.markModified('is_private');
    }
  }

  /** Variação visível para quem não é dono apenas se não for privada. */
  private canViewerReadVariation(
    doc: TrackDocument,
    viewerSub?: string,
  ): boolean {
    const parent = (doc as unknown as { variationOfTrackId?: string })
      .variationOfTrackId;
    if (!parent?.trim()) return true;
    const vKey = (doc as unknown as { variationKey?: string }).variationKey;
    if (!vKey || vKey === '__base__') return true;
    const priv =
      (doc as unknown as { is_private?: boolean }).is_private === true;
    if (!priv) return true;
    const owner =
      typeof (doc as unknown as { owner?: string }).owner === 'string'
        ? (doc as unknown as { owner?: string }).owner!.trim()
        : '';
    const uid = typeof doc.userId === 'string' ? doc.userId.trim() : '';
    const allowedOwner = owner || uid;
    const sub = viewerSub?.trim() || '';
    return Boolean(sub && allowedOwner && sub === allowedOwner);
  }

  private resolveBaseTrackId(track: TrackDocument): string {
    const parent = (track as unknown as { variationOfTrackId?: string })
      .variationOfTrackId;
    if (typeof parent === 'string' && parent.trim()) return parent.trim();
    const self = track.trackId;
    if (typeof self === 'string' && self.trim()) return self.trim();
    return '';
  }

  private async resolvePreferredTrack(
    track: TrackDocument,
    viewerSub?: string,
  ): Promise<TrackDocument> {
    const normalizedSub = viewerSub?.trim() || '';
    const baseTrackId = this.resolveBaseTrackId(track);
    if (!normalizedSub || !baseTrackId) return track;
    const ownVariation = await this.trackModel
      .findOne({
        variationOfTrackId: baseTrackId,
        owner: normalizedSub,
      })
      .populate('artistId')
      .exec();
    return ownVariation ?? track;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
