import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Artist, ArtistDocument } from '../artists/schemas/artist.schema';
import { RecognizedSongDto } from '../integrations/music-recognition/recognized-song.dto';
import { Track, TrackDocument } from './schemas/track.schema';

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
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
