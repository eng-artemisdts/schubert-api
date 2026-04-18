import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Artist, ArtistSchema } from '../artists/schemas/artist.schema';
import { SlugModule } from '../slug/slug.module';
import { Track, TrackSchema } from '../tracks/schemas/track.schema';
import {
  AUDIOSHAKE_TRANSCRIPTION_PROVIDER,
  CHORD_SECTION_PROVIDER,
  LYRICS_SEARCH_PROVIDER,
  WHISPER_TRANSCRIPTION_PROVIDER,
} from './ingest.tokens';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { AudioshakeLyricsTranscriptionProvider } from './providers/audioshake-lyrics-transcription.provider';
import { LrclibLyricsSearchProvider } from './providers/lrclib-lyrics-search.provider';
import { MusicAiChordSectionProvider } from './providers/music-ai-chord-section.provider';
import { WhisperLyricsTranscriptionProvider } from './providers/whisper-lyrics-transcription.provider';
import { LyricsTranscriptionStrategyFactory } from './strategies/lyrics-transcription-strategy.factory';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Track.name, schema: TrackSchema },
      { name: Artist.name, schema: ArtistSchema },
    ]),
    SlugModule,
  ],
  controllers: [IngestController],
  providers: [
    IngestService,
    LyricsTranscriptionStrategyFactory,
    { provide: CHORD_SECTION_PROVIDER, useClass: MusicAiChordSectionProvider },
    { provide: LYRICS_SEARCH_PROVIDER, useClass: LrclibLyricsSearchProvider },
    { provide: WHISPER_TRANSCRIPTION_PROVIDER, useClass: WhisperLyricsTranscriptionProvider },
    { provide: AUDIOSHAKE_TRANSCRIPTION_PROVIDER, useClass: AudioshakeLyricsTranscriptionProvider },
  ],
})
export class IngestModule {}
