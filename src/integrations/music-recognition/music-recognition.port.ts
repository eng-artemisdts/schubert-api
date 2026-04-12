import { RecognizedSongDto } from './recognized-song.dto';

/**
 * Abstraction over music fingerprinting / recognition APIs (AudD, ACRCloud, etc.).
 * Implementations must not leak provider-specific response shapes outside this port.
 */
export abstract class MusicRecognitionPort {
  abstract recognizeFromAudioBuffer(input: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
  }): Promise<RecognizedSongDto | null>;
}
