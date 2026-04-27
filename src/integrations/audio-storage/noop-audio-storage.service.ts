import { Injectable } from '@nestjs/common';
import { AudioStoragePort, UploadIngestAudioInput } from './audio-storage.port';

@Injectable()
export class NoopAudioStorageService extends AudioStoragePort {
  override async uploadIngestAudio(
    _input: UploadIngestAudioInput,
  ): Promise<string | null> {
    return null;
  }
}
