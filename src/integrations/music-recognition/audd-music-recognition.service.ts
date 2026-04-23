import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, fetch as undiciFetch, FormData } from 'undici';
import { truncateMp3BufferToMaxDurationSeconds } from './mp3-truncate.util';
import { MusicRecognitionPort } from './music-recognition.port';
import { RecognizedSongDto } from './recognized-song.dto';

type AudDResult = {
  artist: string;
  title: string;
  album: string;
  release_date: string;
  label: string;
  timecode: string;
  song_link: string;
  spotify?: {
    id: string;
    artists?: { id?: string }[];
    duration_ms?: number;
    album?: {
      images?: { url: string; width?: number; height?: number }[];
    };
  };
  apple_music?: {
    id: string;
    attributes?: { durationInMillis?: number };
    durationInMillis?: number;
    artwork?: { url?: string };
  };
};

type AudDResponse =
  | { status: 'success'; result: AudDResult | null }
  | {
      status: 'error';
      error?: { error_code: number; error_message: string };
    };

/** Documentação AudD: ficheiro demasiado grande — ~10 MB e ~25 s de áudio no máximo. */
const AUDD_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** AudD só precisa de excerto para reconhecimento; evita upload/circuitos completos. */
const AUDD_MAX_AUDIO_SECONDS = 25;

function shouldTruncateAsMp3(input: {
  filename: string;
  mimeType: string;
}): boolean {
  const name = (input.filename ?? '').toLowerCase();
  const mime = (input.mimeType ?? '').toLowerCase();
  return (
    name.endsWith('.mp3') ||
    mime === 'audio/mpeg' ||
    mime === 'audio/mp3' ||
    mime === 'audio/x-mpeg'
  );
}

const AUDD_FETCH_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUndiciErrorChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    parts.push(cur.message);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return parts.join(' → ');
}

function isTransientAuddNetworkError(err: unknown): boolean {
  const text = formatUndiciErrorChain(err);
  if (
    /UND_ERR_SOCKET|UND_ERR_CONNECT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|EPIPE|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(
      text,
    )
  ) {
    return true;
  }
  const cause =
    err instanceof Error
      ? (err as Error & { cause?: unknown }).cause
      : undefined;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = String((cause as NodeJS.ErrnoException).code);
    return ['EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code);
  }
  return false;
}

@Injectable()
export class AudDMusicRecognitionService
  extends MusicRecognitionPort
  implements OnModuleDestroy
{
  private readonly apiUrl = 'https://api.audd.io/';
  /** Cliente HTTP dedicado: timeouts largos para upload MP3 + resposta AudD (evita `UND_ERR_SOCKET` prematuro do fetch global). */
  private readonly auddHttpAgent = new Agent({
    connectTimeout: 60_000,
    bodyTimeout: 300_000,
    headersTimeout: 120_000,
  });

  constructor(private readonly config: ConfigService) {
    super();
  }

  onModuleDestroy(): void {
    void this.auddHttpAgent.close();
  }

  override async recognizeFromAudioBuffer(input: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
  }): Promise<RecognizedSongDto | null> {
    const token = this.config.get<string>('AUDD_API_TOKEN')?.trim();
    if (!token) {
      throw new InternalServerErrorException(
        'AUDD_API_TOKEN is not configured on the server',
      );
    }

    if (input.buffer.length > AUDD_MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException(
        `O áudio excede o limite da AudD (${AUDD_MAX_UPLOAD_BYTES} bytes). Use um excerto mais curto (recomendado: até ~20 s, < 1 MB).`,
      );
    }

    const bufferForAudD = shouldTruncateAsMp3(input)
      ? truncateMp3BufferToMaxDurationSeconds(
          input.buffer,
          AUDD_MAX_AUDIO_SECONDS,
        )
      : input.buffer;

    const payload = { ...input, buffer: bufferForAudD };

    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await this.postToAudDWithRetries(token, payload);
    } catch (err) {
      console.error('Error calling AudD:', err);
      const chain = formatUndiciErrorChain(err);
      const hint = isTransientAuddNetworkError(err)
        ? ' Erro de rede/socket (timeout, ligação caída ou bloqueio intermédio). Tente um MP3 menor (< 1 MB, ~20 s), outra rede ou desativar VPN/firewall.'
        : '';
      throw new BadGatewayException(
        `Falha ao contactar a AudD: ${chain || (err instanceof Error ? err.message : String(err))}.${hint}`,
      );
    }

    if (!res.ok) {
      throw new BadGatewayException(
        `AudD HTTP error: ${res.status} ${res.statusText}`,
      );
    }

    const data = (await res.json()) as AudDResponse;

    if (data.status === 'error') {
      console.error('Error calling AudD:', data.error);
      const msg = data.error?.error_message ?? 'Unknown AudD error';
      throw new BadGatewayException(`AudD error: ${msg}`);
    }

    if (!data.result) {
      return null;
    }

    return this.mapResult(data.result);
  }

  private buildAudDForm(
    token: string,
    input: {
      buffer: Buffer;
      filename: string;
      mimeType: string;
    },
  ): FormData {
    const form = new FormData();
    form.append('api_token', token);
    form.append('return', 'spotify,apple_music');
    form.append(
      'file',
      new Blob([new Uint8Array(input.buffer)], {
        type: input.mimeType || 'audio/mpeg',
      }),
      input.filename || 'audio.mp3',
    );
    return form;
  }

  private async postToAudDWithRetries(
    token: string,
    input: { buffer: Buffer; filename: string; mimeType: string },
  ): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= AUDD_FETCH_ATTEMPTS; attempt++) {
      const form = this.buildAudDForm(token, input);
      try {
        return await undiciFetch(this.apiUrl, {
          method: 'POST',
          body: form,
          dispatcher: this.auddHttpAgent,
        });
      } catch (err) {
        lastError = err;
        if (attempt < AUDD_FETCH_ATTEMPTS && isTransientAuddNetworkError(err)) {
          await delay(350 * attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private mapResult(r: AudDResult): RecognizedSongDto {
    const spotifyArtistIds =
      r.spotify?.artists
        ?.map((a) => a.id)
        .filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ) ?? [];

    const durationMs =
      r.spotify?.duration_ms ??
      r.apple_music?.durationInMillis ??
      r.apple_music?.attributes?.durationInMillis;

    return {
      title: r.title,
      artist: r.artist,
      album: r.album,
      release_date: r.release_date,
      label: r.label,
      timecode: r.timecode,
      song_link: r.song_link,
      spotify_track_id: r.spotify?.id,
      spotify_artist_ids: spotifyArtistIds,
      duration_ms: durationMs,
      cover_image_url: this.pickCoverImageUrl(r),
    };
  }

  /** Spotify e Apple Music (via `return`) trazem arte; escolhe a maior imagem do Spotify quando existir. */
  private pickCoverImageUrl(r: AudDResult): string | undefined {
    const images = r.spotify?.album?.images;
    if (images?.length) {
      const best = [...images].sort(
        (a, b) =>
          (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
      )[0];
      const url = best?.url?.trim();
      if (url) return url;
    }

    const raw = r.apple_music?.artwork?.url?.trim();
    if (!raw) return undefined;
    return raw.replaceAll('{w}', '640').replaceAll('{h}', '640');
  }
}
