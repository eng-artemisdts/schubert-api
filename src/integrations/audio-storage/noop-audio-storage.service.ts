import { Injectable, Logger } from '@nestjs/common';
import { AudioStoragePort, UploadIngestAudioInput } from './audio-storage.port';

@Injectable()
export class NoopAudioStorageService extends AudioStoragePort {
  private readonly logger = new Logger(NoopAudioStorageService.name);

  override async uploadIngestAudio(
    input: UploadIngestAudioInput,
  ): Promise<string | null> {
    this.logger.warn(
      `AUDIO_STORAGE_PROVIDER=noop — áudio não enviado ao S3 (trackHint=${input.trackIdHint ?? 'n/a'} bytes=${input.buffer?.length ?? 0}).`,
    );
    return null;
  }
}
