import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Artist, ArtistSchema } from '../artists/schemas/artist.schema';
import { Track, TrackSchema } from '../tracks/schemas/track.schema';
import { SlugService } from './slug.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Artist.name, schema: ArtistSchema },
      { name: Track.name, schema: TrackSchema },
    ]),
  ],
  providers: [SlugService],
  exports: [SlugService],
})
export class SlugModule {}
