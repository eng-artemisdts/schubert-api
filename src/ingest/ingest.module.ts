import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Artist, ArtistSchema } from '../artists/schemas/artist.schema';
import { AudioStorageModule } from '../integrations/audio-storage/audio-storage.module';
import { IngestCacheModule } from '../integrations/ingest-cache/ingest-cache.module';
import { SpotifyMetadataModule } from '../integrations/spotify-metadata/spotify-metadata.module';
import { StreamAudioExtractModule } from '../integrations/stream-audio-extract/stream-audio-extract.module';
import { YoutubeSearchModule } from '../integrations/youtube-search/youtube-search.module';
import { IngestJobsModule } from '../ingest-jobs/ingest-jobs.module';
import { QueueModule } from '../queue/queue.module';
import { QueueWorkerService } from '../queue/queue.worker.service';
import { SlugModule } from '../slug/slug.module';
import { Track, TrackSchema } from '../tracks/schemas/track.schema';
import {
  AUDIOSHAKE_TRANSCRIPTION_PROVIDER,
  CHORD_SECTION_PROVIDER,
  LYRICS_SEARCH_PROVIDER,
} from './ingest.tokens';
import { IngestController } from './ingest.controller';
import { IngestUrlService } from './ingest-url.service';
import { IngestService } from './ingest.service';
import { AudioshakeLyricsTranscriptionProvider } from './providers/audioshake-lyrics-transcription.provider';
import { LrclibLyricsSearchProvider } from './providers/lrclib-lyrics-search.provider';
import { MusicAiChordSectionProvider } from './providers/music-ai-chord-section.provider';
import { LyricsTranscriptionStrategyFactory } from './strategies/lyrics-transcription-strategy.factory';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Track.name, schema: TrackSchema },
      { name: Artist.name, schema: ArtistSchema },
    ]),
    SlugModule,
    AudioStorageModule,
    IngestCacheModule,
    YoutubeSearchModule,
    IngestJobsModule,
    QueueModule,
    SpotifyMetadataModule,
    StreamAudioExtractModule,
  ],
  controllers: [IngestController],
  providers: [
    IngestService,
    IngestUrlService,
    LyricsTranscriptionStrategyFactory,
    { provide: CHORD_SECTION_PROVIDER, useClass: MusicAiChordSectionProvider },
    { provide: LYRICS_SEARCH_PROVIDER, useClass: LrclibLyricsSearchProvider },
    {
      provide: AUDIOSHAKE_TRANSCRIPTION_PROVIDER,
      useClass: AudioshakeLyricsTranscriptionProvider,
    },
    QueueWorkerService,
  ],
})
export class IngestModule { }
