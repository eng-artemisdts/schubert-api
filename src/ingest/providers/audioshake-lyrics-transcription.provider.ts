import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { File } from 'node:buffer';
import { fetch, FormData } from 'undici';

import type { ILyricsTranscriptionProvider, TranscriptionOptions } from '../domain/lyrics-transcription.port';
import { audioshakeJsonToLyricSegments } from '../mappers/audioshake-lyrics-json.mapper';

const LANG_LABEL: Record<string, string> = {
  en: 'english',
  pt: 'portuguese',
  es: 'spanish',
};

@Injectable()
export class AudioshakeLyricsTranscriptionProvider implements ILyricsTranscriptionProvider {
  private readonly logger = new Logger(AudioshakeLyricsTranscriptionProvider.name);

  constructor(private readonly config: ConfigService) {}

  async transcribe(
    audioPath: string,
    options?: TranscriptionOptions,
  ): Promise<import('../../tracks/schemas/track.schema').TranscriptionLyricSegmentSubdoc[]> {
    const apiKey = this.config.get<string>('AUDIOSHAKE_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'AUDIOSHAKE_API_KEY não configurada — transcrição AudioShake indisponível.',
      );
    }

    const base = (this.config.get<string>('AUDIOSHAKE_BASE')?.trim() || 'https://api.audioshake.ai').replace(
      /\/$/,
      '',
    );
    const model = (this.config.get<string>('AUDIOSHAKE_MODEL')?.trim() || 'alignment').toLowerCase();
    if (!['transcription', 'alignment'].includes(model)) {
      throw new ServiceUnavailableException(`AUDIOSHAKE_MODEL inválido: ${model}`);
    }

    const pollMs = Math.max(
      1000,
      parseInt(this.config.get<string>('AUDIOSHAKE_POLL_MS')?.trim() || '5000', 10) || 5000,
    );
    const lang = (options?.language || 'en').toLowerCase().slice(0, 2);
    const languageLabel = LANG_LABEL[lang] || lang || 'unknown';

    const buf = await readFile(audioPath);
    const uploadForm = new FormData();
    uploadForm.append('file', new File([buf], 'audio.mp3', { type: 'audio/mpeg' }));

    const up = await fetch(`${base}/assets`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: uploadForm,
    });
    const upBody = (await up.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!up.ok) {
      throw new ServiceUnavailableException(
        `AudioShake upload: ${up.status} ${upBody.message ?? up.statusText}`,
      );
    }
    const assetId = upBody.id;
    if (!assetId) throw new ServiceUnavailableException('AudioShake: resposta sem asset id');

    const target: Record<string, unknown> = { model, formats: ['json'] };
    if (lang.length === 2) target.language = lang;

    const cr = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ assetId, targets: [target] }),
    });
    const crBody = (await cr.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!cr.ok) {
      throw new ServiceUnavailableException(
        `AudioShake task: ${cr.status} ${crBody.message ?? cr.statusText}`,
      );
    }
    const taskId = crBody.id;
    if (!taskId) throw new ServiceUnavailableException('AudioShake: resposta sem task id');

    let task: Record<string, unknown> = {};
    for (;;) {
      const tr = await fetch(`${base}/tasks/${taskId}`, { headers: { 'x-api-key': apiKey } });
      task = (await tr.json().catch(() => ({}))) as Record<string, unknown>;
      if (!tr.ok) {
        throw new ServiceUnavailableException(`AudioShake poll: ${tr.status}`);
      }
      const targets = (task.targets as { status?: string }[]) || [];
      const statuses = targets.map((t) => t.status);
      if (statuses.length && statuses.every((s) => s === 'completed' || s === 'error')) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }

    const targets = (task.targets as Record<string, unknown>[]) || [];
    const t = targets.find((x) => String(x.model) === model) ?? targets[0];
    if (!t) throw new ServiceUnavailableException('AudioShake: sem targets na task');
    if (t.status === 'error') {
      throw new ServiceUnavailableException(`AudioShake target erro: ${JSON.stringify(t.error)}`);
    }
    const outputs = (t.output as { format?: string; link?: string }[]) || [];
    const jsonOut = outputs.find((o) => o.format === 'json') || outputs[0];
    if (!jsonOut?.link) throw new ServiceUnavailableException('AudioShake: sem link JSON');

    const dl = await fetch(jsonOut.link);
    if (!dl.ok) throw new ServiceUnavailableException(`AudioShake download: ${dl.status}`);
    const rawJson = (await dl.json().catch(() => null)) as unknown;

    const segments = audioshakeJsonToLyricSegments(rawJson, languageLabel);
    this.logger.log(`AudioShake: ${segments.length} segmento(s), model=${model}`);
    return segments;
  }
}
