import { randomBytes } from 'crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { IngestCallerLogPayload } from '../auth/caller-context.util';
import {
  SpotifyMetadataPort,
  type SpotifyTrackMeta,
} from '../integrations/spotify-metadata/spotify-metadata.port';
import { StreamAudioExtractPort } from '../integrations/stream-audio-extract/stream-audio-extract.port';
import { YoutubeSearchPort } from '../integrations/youtube-search/youtube-search.port';
import { IngestJobsService } from '../ingest-jobs/ingest-jobs.service';
import { QueueProducerService } from '../queue/queue.producer.service';
import type { IngestUrlDto } from './dto/ingest-url.dto';
import { IngestService } from './ingest.service';
import { detectSourcePlatform } from './platform-detect.util';

export type IngestUrlQueuedResult = {
  jobId: string;
  status: string;
  progressPercent: number;
};

export type IngestUrlSyncResult = {
  track: Record<string, unknown>;
  status: 'completed';
};

export type IngestUrlResult = IngestUrlQueuedResult | IngestUrlSyncResult;

type ResolvedMeta =
  | SpotifyTrackMeta
  | {
      title: string;
      artist: string;
      album?: string;
      spotifyTrackId?: string;
      coverImageUrl?: string;
      spotifyArtistIds: string[];
      durationMs?: number;
    }
  | null;

@Injectable()
export class IngestUrlService {
  private readonly logger = new Logger(IngestUrlService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly streamExtract: StreamAudioExtractPort,
    private readonly spotifyMeta: SpotifyMetadataPort,
    private readonly youtubeSearch: YoutubeSearchPort,
    private readonly ingestJobs: IngestJobsService,
    private readonly queueProducer: QueueProducerService,
    private readonly ingestService: IngestService,
  ) {}

  async ingestFromUrl(dto: IngestUrlDto, caller: IngestCallerLogPayload): Promise<IngestUrlResult> {
    const platform = detectSourcePlatform(dto.sourceUrl);

    if (platform === 'unknown') {
      throw new BadRequestException(
        'Plataforma não suportada. Use links do YouTube, Spotify, TikTok ou Instagram.',
      );
    }

    const meta = await this.resolveMetadata(dto, platform);
    const audioSourceUrl = await this.resolveAudioUrl(dto.sourceUrl, platform, meta);

    this.logger.log(`[ingest-url] plataforma=${platform} audioSource=${audioSourceUrl}`);

    const extraction = await this.streamExtract.extract({ sourceUrl: audioSourceUrl });

    const resolvedTitle = meta?.title ?? extraction.title ?? 'Untitled';
    const resolvedArtist = meta?.artist ?? extraction.uploader ?? 'Unknown Artist';

    const metaRaw = this.buildMetaRaw({
      dto,
      meta,
      resolvedTitle,
      resolvedArtist,
      audioSourceUrl,
      platform,
    });

    const fileBuffer = extraction.buffer;
    const fakeFile = {
      buffer: fileBuffer,
      originalname: extraction.fileName,
      mimetype: extraction.mimeType,
      size: fileBuffer.length,
    } as Express.Multer.File;

    const asyncEnabled = this.config.get<string>('INGEST_ASYNC_ENABLED') === '1';

    if (!asyncEnabled) {
      const track = await this.ingestService.run({
        file: fakeFile,
        metaRaw,
        caller,
      });
      const t = track as unknown as { toJSON?: () => Record<string, unknown> };
      const json =
        typeof t.toJSON === 'function' ? t.toJSON() : (track as unknown as Record<string, unknown>);
      return { track: json, status: 'completed' };
    }

    if (!this.queueProducer.isAvailable()) {
      throw new ServiceUnavailableException(
        'Ingestão assíncrona indisponível: configure REDIS_URL e INGEST_ASYNC_ENABLED=1.',
      );
    }

    const idempotencyKey = this.ingestJobs.createIdempotencyKey({
      ownerSub: caller.auth0Sub,
      fileBuffer,
      metaRaw,
    });

    const existing = await this.ingestJobs.findActiveByIdempotencyKey(idempotencyKey);
    if (existing) {
      return {
        jobId: existing.jobId,
        status: existing.status,
        progressPercent: existing.progressPercent,
      };
    }

    const job = await this.ingestJobs.createQueuedJob({
      ownerSub: caller.auth0Sub,
      idempotencyKey,
      inputRef: {
        sourceUrl: dto.sourceUrl,
        platform,
        fileName: extraction.fileName,
        fileSize: fileBuffer.length,
      },
    });

    await this.queueProducer.enqueueIngest({
      jobId: job.jobId,
      ownerSub: caller.auth0Sub,
      fileName: extraction.fileName,
      mimeType: extraction.mimeType,
      fileBase64: fileBuffer.toString('base64'),
      metaRaw,
      caller,
    });

    this.logger.log(`[ingest-url] job=${job.jobId} plataforma=${platform} faixa="${resolvedTitle}"`);

    return { jobId: job.jobId, status: 'queued', progressPercent: 0 };
  }

  private async resolveMetadata(
    dto: IngestUrlDto,
    platform: ReturnType<typeof detectSourcePlatform>,
  ): Promise<ResolvedMeta> {
    if (platform === 'spotify') {
      const spotifyMeta = await this.spotifyMeta.getTrackMeta(dto.sourceUrl);
      if (spotifyMeta) return spotifyMeta;
    }

    if (dto.title?.trim() && dto.artist?.trim()) {
      return {
        title: dto.title.trim(),
        artist: dto.artist.trim(),
        album: dto.album?.trim(),
        spotifyTrackId: dto.spotifyTrackId?.trim(),
        coverImageUrl: dto.coverImageUrl?.trim(),
        spotifyArtistIds: [],
      };
    }

    return null;
  }

  private async resolveAudioUrl(
    originalUrl: string,
    platform: ReturnType<typeof detectSourcePlatform>,
    meta: { title?: string; artist?: string } | null,
  ): Promise<string> {
    if (platform !== 'spotify') return originalUrl;

    if (!meta?.title || !meta?.artist) {
      throw new BadRequestException(
        'Não foi possível identificar a faixa Spotify. Verifique se o link é válido ou envie title/artist no body.',
      );
    }

    const youtubeUrl = await this.youtubeSearch.findSongVideoUrl({
      title: meta.title,
      artist: meta.artist,
    });

    if (!youtubeUrl) {
      throw new BadRequestException(
        `Não foi possível encontrar "${meta.title}" de "${meta.artist}" no YouTube para extrair o áudio.`,
      );
    }

    return youtubeUrl;
  }

  private buildMetaRaw(opts: {
    dto: IngestUrlDto;
    meta: ResolvedMeta;
    resolvedTitle: string;
    resolvedArtist: string;
    audioSourceUrl: string;
    platform: ReturnType<typeof detectSourcePlatform>;
  }): Record<string, unknown> {
    const { dto, meta, resolvedTitle, resolvedArtist, audioSourceUrl, platform } = opts;
    const trackId = `url_${randomBytes(4).toString('hex')}`;

    const spotifyTrackId =
      meta && 'spotifyTrackId' in meta && meta.spotifyTrackId
        ? meta.spotifyTrackId
        : dto.spotifyTrackId?.trim() ?? '';

    const spotifyArtistIds =
      meta && 'spotifyArtistIds' in meta && meta.spotifyArtistIds?.length
        ? meta.spotifyArtistIds
        : [];

    const durationMs =
      meta && 'durationMs' in meta && meta.durationMs != null ? meta.durationMs : undefined;

    const youtubeUrl =
      platform === 'youtube' || platform === 'spotify' ? audioSourceUrl : undefined;

    const metaRaw: Record<string, unknown> = {
      title: meta?.title ?? resolvedTitle,
      artist: meta?.artist ?? resolvedArtist,
      album: meta?.album ?? dto.album ?? '',
      spotify_track_id: spotifyTrackId,
      spotify_artist_ids: spotifyArtistIds,
      cover_image_url: meta?.coverImageUrl ?? dto.coverImageUrl ?? '',
      song_link: dto.sourceUrl.trim(),
      youtube_url: youtubeUrl,
      trackId,
      name: resolvedTitle,
    };

    if (durationMs !== undefined) {
      metaRaw.duration_ms = durationMs;
    }

    if (dto.variationOfTrackId?.trim()) {
      metaRaw.variationOfTrackId = dto.variationOfTrackId.trim();
    }

    return metaRaw;
  }
}
