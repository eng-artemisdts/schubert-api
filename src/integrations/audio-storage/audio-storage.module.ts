import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AudioStoragePort } from './audio-storage.port';
import { NoopAudioStorageService } from './noop-audio-storage.service';
import { S3AudioStorageService } from './s3-audio-storage.service';

const audioStorageLogger = new Logger('AudioStorageModule');

@Module({
  providers: [
    NoopAudioStorageService,
    S3AudioStorageService,
    {
      provide: AudioStoragePort,
      inject: [ConfigService, NoopAudioStorageService, S3AudioStorageService],
      useFactory: (
        config: ConfigService,
        noop: NoopAudioStorageService,
        s3: S3AudioStorageService,
      ) => {
        const provider =
          config.get<string>('AUDIO_STORAGE_PROVIDER')?.trim().toLowerCase() ||
          'noop';
        if (provider === 's3') {
          audioStorageLogger.log('Provider activo: S3 (S3AudioStorageService)');
          return s3;
        }
        audioStorageLogger.warn(
          `Provider activo: noop (AUDIO_STORAGE_PROVIDER=${provider || 'noop'}). Áudios de ingestão não sobem para S3.`,
        );
        return noop;
      },
    },
  ],
  exports: [AudioStoragePort],
})
export class AudioStorageModule {}
