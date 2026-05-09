import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdir, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  StreamAudioExtractInput,
  StreamAudioExtractPort,
  StreamAudioExtractResult,
} from './stream-audio-extract.port';

const TMP_SUBDIR = 'schubert-stream-extract';
const DEFAULT_MAX_DURATION_SEC = 600;

@Injectable()
export class YtDlpAudioExtractService extends StreamAudioExtractPort {
  private readonly logger = new Logger(YtDlpAudioExtractService.name);

  constructor(private readonly config: ConfigService) {
    super();
  }

  override async extract(input: StreamAudioExtractInput): Promise<StreamAudioExtractResult> {
    const format = input.audioFormat ?? 'mp3';
    const outputId = randomBytes(8).toString('hex');
    const tmpDir = join(tmpdir(), TMP_SUBDIR);
    await mkdir(tmpDir, { recursive: true });

    const outputTemplate = join(tmpDir, `${outputId}.%(ext)s`);
    const outputPath = join(tmpDir, `${outputId}.${format}`);

    const ytDlpBin = this.config.get<string>('YTDLP_BINARY')?.trim() || 'yt-dlp';
    const ffmpegBin = this.config.get<string>('FFMPEG_BINARY')?.trim() || 'ffmpeg';
    const tiktokCookies = this.config.get<string>('TIKTOK_COOKIES_FILE')?.trim();
    const igCookies = this.config.get<string>('INSTAGRAM_COOKIES_FILE')?.trim();
    const maxDuration = Number(
      this.config.get<string>('AUDIO_MAX_DURATION_SEC') || DEFAULT_MAX_DURATION_SEC,
    );

    const args = this.buildArgs({
      url: input.sourceUrl,
      format,
      outputTemplate,
      ffmpegBin,
      tiktokCookies,
      igCookies,
      maxDuration,
    });

    const meta = await this.runYtDlp(ytDlpBin, args);

    let buffer: Buffer;
    try {
      buffer = await readFile(outputPath);
    } catch {
      throw new ServiceUnavailableException(
        'Extração concluída mas o ficheiro de áudio não foi encontrado no temporário. Tente novamente.',
      );
    }

    void unlink(outputPath).catch(() => undefined);

    return {
      buffer,
      mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      fileName: `${outputId}.${format}`,
      title: meta.title,
      durationSec: meta.duration,
      uploader: meta.uploader,
    };
  }

  private buildArgs(opts: {
    url: string;
    format: string;
    outputTemplate: string;
    ffmpegBin: string;
    tiktokCookies?: string;
    igCookies?: string;
    maxDuration: number;
  }): string[] {
    const isTikTok = /tiktok\.com|vm\.tiktok\.com/i.test(opts.url);
    const isInstagram = /instagram\.com|instagr\.am/i.test(opts.url);

    const args: string[] = [
      '--extract-audio',
      '--audio-format',
      opts.format,
      '--audio-quality',
      '0',
      '--no-playlist',
      '--no-warnings',
      '--print-json',
      '--match-filter',
      `duration <= ${opts.maxDuration}`,
      '--output',
      opts.outputTemplate,
      '--extractor-args',
      'youtube:player_client=web_safari,android',
    ];

    const ffmpegPath = opts.ffmpegBin.trim();
    if (ffmpegPath.includes('/') || ffmpegPath.includes('\\')) {
      args.push('--ffmpeg-location', dirname(ffmpegPath));
    }

    if (isTikTok) {
      if (opts.tiktokCookies) args.push('--cookies', opts.tiktokCookies);
      args.push(
        '--extractor-args',
        'tiktok:app_info=1234567890123456789/trill/34.1.2/2023401020/1180',
      );
    }

    if (isInstagram && opts.igCookies) {
      args.push('--cookies', opts.igCookies);
    }

    args.push(opts.url);
    return args;
  }

  private runYtDlp(
    bin: string,
    args: string[],
  ): Promise<{ title?: string; duration?: number; uploader?: string }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn(bin, args);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          this.logger.error(`yt-dlp saiu com código ${code}: ${stderr.slice(0, 500)}`);
          return reject(
            new ServiceUnavailableException(
              `Falha ao extrair áudio (yt-dlp exit ${code}). Verifique se a URL é válida e pública.`,
            ),
          );
        }
        try {
          const lastLine = stdout.trim().split('\n').pop() ?? '{}';
          const meta = JSON.parse(lastLine) as {
            title?: string;
            duration?: number;
            uploader?: string;
          };
          resolve(meta);
        } catch {
          resolve({});
        }
      });

      proc.on('error', (err) => {
        reject(
          new ServiceUnavailableException(
            `yt-dlp não encontrado ou inacessível: ${err.message}. Instale com: pip install yt-dlp`,
          ),
        );
      });
    });
  }
}
