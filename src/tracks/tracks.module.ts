import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Artist, ArtistSchema } from '../artists/schemas/artist.schema';
import { IngestModule } from '../ingest/ingest.module';
import { MusicRecognitionModule } from '../integrations/music-recognition/music-recognition.module';
import { Track, TrackSchema } from './schemas/track.schema';
import { TracksController } from './tracks.controller';
import { TracksIndexMigrationService } from './tracks-index-migration.service';
import { TracksService } from './tracks.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Track.name, schema: TrackSchema },
      { name: Artist.name, schema: ArtistSchema },
    ]),
    MusicRecognitionModule,
    IngestModule,
  ],
  controllers: [TracksController],
  providers: [TracksService, TracksIndexMigrationService],
})
export class TracksModule { }
