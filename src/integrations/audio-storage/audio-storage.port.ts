export type UploadIngestAudioInput = {
  buffer: Buffer;
  mimeType: string;
  ownerSub: string;
  trackIdHint?: string;
};

export abstract class AudioStoragePort {
  abstract uploadIngestAudio(
    input: UploadIngestAudioInput,
  ): Promise<string | null>;
}
