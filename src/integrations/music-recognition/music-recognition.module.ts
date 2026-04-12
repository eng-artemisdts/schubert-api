import { Module } from '@nestjs/common';
import { AudDMusicRecognitionService } from './audd-music-recognition.service';
import { MusicRecognitionPort } from './music-recognition.port';

@Module({
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
