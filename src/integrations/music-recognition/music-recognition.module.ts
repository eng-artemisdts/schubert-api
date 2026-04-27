import { Module } from '@nestjs/common';
import { AudDMusicRecognitionService } from './audd-music-recognition.service';
import { MusicRecognitionPort } from './music-recognition.port';
import { YoutubeSearchModule } from '../youtube-search/youtube-search.module';

@Module({
  imports: [YoutubeSearchModule],
  providers: [
    AudDMusicRecognitionService,
    {
      provide: MusicRecognitionPort,
      useExisting: AudDMusicRecognitionService,
    },
  ],
  exports: [MusicRecognitionPort],
})
export class MusicRecognitionModule {}
