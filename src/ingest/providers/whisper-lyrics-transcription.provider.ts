import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { File } from 'node:buffer';
import { fetch, FormData } from 'undici';

import type { ILyricsTranscriptionProvider, TranscriptionOptions } from '../domain/lyrics-transcription.port';
import type { TranscriptionLyricSegmentSubdoc } from '../../tracks/schemas/track.schema';
import { openAiWhisperVerboseToSegments } from '../mappers/openai-whisper-verbose.mapper';

@Injectable()
export class WhisperLyricsTranscriptionProvider implements ILyricsTranscriptionProvider {
  private readonly logger = new Logger(WhisperLyricsTranscriptionProvider.name);

  constructor(private readonly config: ConfigService) {}

  async transcribe(audioPath: string, options?: TranscriptionOptions): Promise<TranscriptionLyricSegmentSubdoc[]> {
    const key = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!key) {
      throw new ServiceUnavailableException(
        'OPENAI_API_KEY não configurada — transcrição Whisper indisponível.',
      );
    }

    const buf = await readFile(audioPath);
    const lang = options?.language?.slice(0, 2) || 'en';
    const form = new FormData();
    form.append('file', new File([buf], 'audio.mp3', { type: 'audio/mpeg' }));
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('language', lang);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });

    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
      const msg =
        typeof json === 'object' && json && 'error' in json
          ? JSON.stringify((json as { error: unknown }).error)
          : res.statusText;
      this.logger.error(`Whisper API erro ${res.status}: ${msg}`);
      throw new ServiceUnavailableException(`Whisper: ${res.status}`);
    }

    const segments = openAiWhisperVerboseToSegments(json);
    this.logger.log(`Whisper: ${segments.length} segmento(s).`);
    return segments;
  }
}
