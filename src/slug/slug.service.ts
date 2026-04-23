import { randomBytes } from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { Artist, ArtistDocument } from '../artists/schemas/artist.schema';
import { Track, TrackDocument } from '../tracks/schemas/track.schema';
import { slugFromDisplayName } from './slug.util';

@Injectable()
export class SlugService {
  constructor(
    @InjectModel(Artist.name)
    private readonly artistModel: Model<ArtistDocument>,
    @InjectModel(Track.name) private readonly trackModel: Model<TrackDocument>,
  ) {}

  /** Slug único na coleção `artists`. */
  async allocateArtistSlug(displayName: string): Promise<string> {
    const base = slugFromDisplayName(displayName);
    let candidate = base;
    for (let i = 0; i < 20; i++) {
      const clash = await this.artistModel
        .findOne({ slug: candidate })
        .select('_id')
        .lean()
        .exec();
      if (!clash) return candidate;
      const suffix = i === 0 ? randomBytes(2).toString('hex') : `${i + 1}`;
      candidate = `${base}-${suffix}`;
    }
    return `${base}-${randomBytes(4).toString('hex')}`;
  }

  /** Slug único por artista na coleção `tracks`. */
  async allocateTrackSlug(
    artistId: Types.ObjectId,
    displayName: string,
  ): Promise<string> {
    const base = slugFromDisplayName(displayName);
    let candidate = base;
    for (let i = 0; i < 20; i++) {
      const clash = await this.trackModel
        .findOne({ artistId, slug: candidate })
        .select('_id')
        .lean()
        .exec();
      if (!clash) return candidate;
      const suffix = i === 0 ? randomBytes(2).toString('hex') : `${i + 1}`;
      candidate = `${base}-${suffix}`;
    }
    return `${base}-${randomBytes(4).toString('hex')}`;
  }
}
