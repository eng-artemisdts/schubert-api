import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Artist, ArtistDocument } from '../artists/schemas/artist.schema';
import { RecognizedSongDto } from '../integrations/music-recognition/recognized-song.dto';
import type { TranscriptionLyricsVariantsSubdoc } from './schemas/track.schema';
import { Track, TrackDocument } from './schemas/track.schema';
import { normalizeChordListFromClient } from './transcription-chord-normalize.util';
import { normalizeSectionListFromClient } from './transcription-section-normalize.util';

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
   * Atualiza acordes, variantes de letra e/ou secções; só o dono (`owner` ou `userId`) pode gravar.
   */
  async updateTranscriptionByPublicKey(
    key: string,
    ownerSub: string,
    body: {
      chords?: unknown;
      lyricsVariants?: Partial<TranscriptionLyricsVariantsSubdoc>;
      sections?: unknown;
    },
  ): Promise<TrackDocument> {
    const track = await this.findByPublicKey(key);
    if (!track) {
      throw new NotFoundException(`Nenhuma faixa com a chave «${key}».`);
    }
    const owner = (track as unknown as { owner?: string }).owner;
    const uid = track.userId;
    const allowed =
      (typeof owner === 'string' && owner === ownerSub) ||
      (typeof uid === 'string' && uid === ownerSub);
    if (!allowed) {
      throw new ForbiddenException('Sem permissão para editar esta faixa.');
    }

    if (body.chords !== undefined) {
      const durationSec = track.meta?.duration_seconds;
      track.chords = normalizeChordListFromClient(body.chords, durationSec);
      track.markModified('chords');
    }

    if (body.lyricsVariants !== undefined) {
      const cur = track.lyricsVariants ?? {};
      const next: TranscriptionLyricsVariantsSubdoc = { ...cur };
      if (body.lyricsVariants.ai !== undefined) {
        next.ai = body.lyricsVariants.ai as TranscriptionLyricsVariantsSubdoc['ai'];
      }
      if (body.lyricsVariants.match !== undefined) {
        next.match = body.lyricsVariants.match as TranscriptionLyricsVariantsSubdoc['match'];
      }
      track.lyricsVariants = next;
      track.markModified('lyricsVariants');
    }

    if (body.sections !== undefined) {
      track.sections = normalizeSectionListFromClient(body.sections);
      track.markModified('sections');
    }

    await track.save();
    const fresh = await this.findByPublicKey(key);
    if (!fresh) {
      throw new NotFoundException(`Faixa «${key}» não encontrada após atualização.`);
    }
    return fresh;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
