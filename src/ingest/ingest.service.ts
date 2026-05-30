import { createHash, randomBytes } from 'crypto';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { writeFile } from 'fs/promises';
import { Model, Types } from 'mongoose';

import type {
  IngestCallerLogPayload,
  IngestBillingPlan,
} from '../auth/caller-context.util';
import { resolveIngestBillingPlan } from '../auth/caller-context.util';
import type { IChordSectionProvider } from './domain/chord-section-analysis.port';
import type { ILyricsSearchProvider } from './domain/lyrics-search.port';
import type {
  LyricsSource,
  MusicTranscriptionMetaSubdoc,
  TranscriptionLyricSegmentSubdoc,
} from '../tracks/schemas/track.schema';
import { Artist, ArtistDocument } from '../artists/schemas/artist.schema';
import { SlugService } from '../slug/slug.service';
import { Track, TrackDocument } from '../tracks/schemas/track.schema';
import { detectOriginalTuneFromChords } from './detect-key.util';
import { parseIngestMultipartMeta } from './ingest-meta.parser';
import {
  CHORD_SECTION_PROVIDER,
  LYRICS_SEARCH_PROVIDER,
} from './ingest.tokens';
import { LyricsTranscriptionStrategyFactory } from './strategies/lyrics-transcription-strategy.factory';
import { YoutubeSearchPort } from '../integrations/youtube-search/youtube-search.port';
import { AudioStoragePort } from '../integrations/audio-storage/audio-storage.port';
import { IngestCachePort } from '../integrations/ingest-cache/ingest-cache.port';

export type IngestRunInput = {
  file: Express.Multer.File;
  metaRaw: unknown;
  caller: IngestCallerLogPayload;
  onStage?: (
    event: {
      stage:
      | 'uploadAudio'
      | 'recognizeSong'
      | 'resolveChordsAndSections'
      | 'resolveLyrics'
      | 'resolveYoutube'
      | 'persistTrack';
      status: 'running' | 'completed' | 'failed';
      progressPercent: number;
      cacheHit?: boolean;
      error?: string;
    },
  ) => Promise<void> | void;
};

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(CHORD_SECTION_PROVIDER)
    private readonly chordSectionProvider: IChordSectionProvider,
    @Inject(LYRICS_SEARCH_PROVIDER)
    private readonly lyricsSearchProvider: ILyricsSearchProvider,
    private readonly transcriptionStrategyFactory: LyricsTranscriptionStrategyFactory,
    @InjectModel(Track.name) private readonly trackModel: Model<TrackDocument>,
    @InjectModel(Artist.name)
    private readonly artistModel: Model<ArtistDocument>,
    private readonly slugService: SlugService,
    private readonly config: ConfigService,
    private readonly youtubeSearch: YoutubeSearchPort,
    private readonly audioStorage: AudioStoragePort,
    private readonly ingestCache: IngestCachePort,
  ) { }

  /**
   * Quando `INGEST_DISABLE_LYRICS_SEARCH` está definida como truthy (ex.: `1`, `true`, `yes`),
   * o pipeline ignora a pesquisa de letra em fontes externas (LRCLIB) e vai sempre pela
   * estratégia de transcrição (`LyricsTranscriptionStrategyFactory`).
   */
  private isLyricsSearchDisabled(): boolean {
    const raw = this.config.get<string>('INGEST_DISABLE_LYRICS_SEARCH');
    if (raw == null) return false;
    return /^(1|true|yes|on)$/i.test(String(raw).trim());
  }

  async run(input: IngestRunInput): Promise<TrackDocument> {
    const stage = async (
      name:
        | 'uploadAudio'
        | 'recognizeSong'
        | 'resolveChordsAndSections'
        | 'resolveLyrics'
        | 'resolveYoutube'
        | 'persistTrack',
      status: 'running' | 'completed' | 'failed',
      progressPercent: number,
      options?: { cacheHit?: boolean; error?: string },
    ) => {
      await input.onStage?.({
        stage: name,
        status,
        progressPercent,
        cacheHit: options?.cacheHit,
        error: options?.error,
      });
    };

    const auth0Sub = input.caller.auth0Sub;
    if (!auth0Sub || auth0Sub.startsWith('(')) {
      throw new UnauthorizedException(
        'Sessão inválida: falta identificador Auth0.',
      );
    }

    const billingPlan: IngestBillingPlan = resolveIngestBillingPlan(
      input.caller,
    );
    const parsed = parseIngestMultipartMeta(input.metaRaw);
    const audioHash = createHash('sha256').update(input.file.buffer).digest('hex');

    const tmpPath = join(
      tmpdir(),
      `schubert-ingest-${randomBytes(8).toString('hex')}.mp3`,
    );
    await writeFile(tmpPath, input.file.buffer);

    try {
      await stage('resolveChordsAndSections', 'running', 15);
      const chordSectionCacheKey = `chordsSections:${audioHash}:v1`;
      const cachedChordSection = await this.ingestCache.get<{
        chords: unknown[];
        sections: unknown[];
        original_tune?: string;
      }>(chordSectionCacheKey);
      const {
        chords,
        sections,
        original_tune: workflowOriginalTune,
      } = cachedChordSection
          ? ({
            chords: cachedChordSection.chords,
            sections: cachedChordSection.sections,
            original_tune: cachedChordSection.original_tune,
          } as Awaited<ReturnType<IChordSectionProvider['analyze']>>)
          : await this.chordSectionProvider.analyze(tmpPath);
      if (!cachedChordSection) {
        await this.ingestCache.set(
          chordSectionCacheKey,
          { chords, sections, original_tune: workflowOriginalTune },
          60 * 60 * 24 * 90,
        );
      }
      await stage('resolveChordsAndSections', 'completed', 35, {
        cacheHit: Boolean(cachedChordSection),
      });

      // Fallback: se o workflow não devolveu tonalidade, deteta a partir dos acordes capturados
      // (tonaljs/key — pontua cada par tónica×modo pelos acordes diatónicos compatíveis).
      const resolvedOriginalTune = (() => {
        const fromWorkflow = workflowOriginalTune?.trim();
        if (fromWorkflow) return fromWorkflow;
        const detected = detectOriginalTuneFromChords(chords);
        if (detected) {
          this.logger.log(
            `Tonalidade detetada via tonal (${chords.length} acorde(s)): ${detected}`,
          );
        }
        return detected;
      })();

      let lyrics: TranscriptionLyricSegmentSubdoc[] = [];
      let lyricsSource: LyricsSource = 'AI';
      let lyricsCacheHit = false;

      const lyricsSearchDisabled = this.isLyricsSearchDisabled();
      const canLrclib =
        !lyricsSearchDisabled &&
        Boolean(parsed.song?.title && parsed.song?.artist);
      await stage('resolveLyrics', 'running', 40);
      if (lyricsSearchDisabled) {
        this.logger.log(
          'Pesquisa LRCLIB desativada via INGEST_DISABLE_LYRICS_SEARCH.',
        );
      }
      if (canLrclib) {
        const song = parsed.song!;
        const durationSec =
          typeof song.duration_ms === 'number' &&
            Number.isFinite(song.duration_ms)
            ? song.duration_ms / 1000
            : parsed.transcriptionMeta?.duration_seconds;
        const match = await this.lyricsSearchProvider.search({
          title: song.title,
          artist: song.artist,
          album: song.album?.trim() || undefined,
          durationSec,
        });
        if (match?.segments?.length) {
          lyrics = match.segments;
          lyricsSource = 'MATCH';
          this.logger.log(
            `Letra LRCLIB: ${match.segments.length} segmento(s).`,
          );
        }
      }

      if (!lyrics.length) {
        const lyricsCacheKey = `lyrics:${audioHash}:${billingPlan
          }:pt`;
        const cachedLyrics = await this.ingestCache.get<{
          lyrics: TranscriptionLyricSegmentSubdoc[];
          source: LyricsSource;
        }>(lyricsCacheKey);
        if (cachedLyrics?.lyrics?.length) {
          lyrics = cachedLyrics.lyrics;
          lyricsSource = cachedLyrics.source;
          lyricsCacheHit = true;
          this.logger.log(`Letra via cache: ${lyrics.length} segmento(s).`);
        } else {
          const tx = this.transcriptionStrategyFactory.select(billingPlan);
          lyrics = await tx.transcribe(tmpPath, { language: 'pt' });
          lyricsSource = 'AI';
          await this.ingestCache.set(
            lyricsCacheKey,
            { lyrics, source: lyricsSource },
            60 * 60 * 24 * 30,
          );
          this.logger.log(
            `Transcrição (AudioShake): ${lyrics.length} segmento(s).`,
          );
        }
      }
      await stage('resolveLyrics', 'completed', 60, {
        cacheHit: lyricsCacheHit,
      });

      const mergedMeta = this.mergeTrackMeta(parsed);
      const trackName =
        parsed.song?.title?.trim() ||
        mergedMeta?.name?.trim() ||
        parsed.transcriptionMeta?.name?.trim() ||
        'Untitled';
      const artistName = parsed.song?.artist?.trim() || 'Unknown Artist';

      const primarySpotifyArtistId = parsed.song?.spotify_artist_ids
        ?.find((id) => typeof id === 'string' && id.trim())
        ?.trim();
      const artistThumbUrl =
        typeof parsed.song?.cover_image_url === 'string' &&
          parsed.song.cover_image_url.trim()
          ? parsed.song.cover_image_url.trim()
          : undefined;
      const artist = await this.ensureArtist(
        artistName,
        primarySpotifyArtistId,
        artistThumbUrl,
      );

      const variationOfTrackId = parsed.variationOfTrackId?.trim() || '';
      const ownedLookupId = parsed.transcriptionMeta?.trackId?.trim();
      const existing = variationOfTrackId
        ? await this.trackModel
          .findOne({
            variationOfTrackId,
            owner: auth0Sub,
          })
          .exec()
        : ownedLookupId
          ? await this.trackModel
            .findOne({ trackId: ownedLookupId, owner: auth0Sub })
            .exec()
          : null;

      const preferredNewId =
        (variationOfTrackId ? `${variationOfTrackId}__${auth0Sub}` : '') ||
        parsed.transcriptionMeta?.trackId?.trim() ||
        parsed.song?.spotify_track_id?.trim();
      const trackId =
        existing?.trackId ?? (await this.allocateGlobalTrackId(preferredNewId));

      await stage('uploadAudio', 'running', 65);
      const storageProvider =
        this.config.get<string>('AUDIO_STORAGE_PROVIDER')?.trim().toLowerCase() ||
        'noop';
      const fileBytes = input.file.buffer?.length ?? 0;
      this.logger.log(
        `uploadAudio: provider=${storageProvider} trackId=${trackId} bytes=${fileBytes} mime=${input.file.mimetype || 'audio/mpeg'}`,
      );
      if (!fileBytes) {
        const msg = 'Ficheiro de áudio vazio — não é possível enviar ao storage.';
        this.logger.error(`uploadAudio: ${msg}`);
        await stage('uploadAudio', 'failed', 72, { error: msg });
      }
      const uploadedAudioUrl =
        fileBytes > 0
          ? await this.audioStorage
              .uploadIngestAudio({
                buffer: input.file.buffer,
                mimeType: input.file.mimetype || 'audio/mpeg',
                ownerSub: auth0Sub,
                trackIdHint: trackId,
              })
              .catch((err) => {
                const message =
                  err instanceof Error ? err.message : String(err);
                this.logger.error(
                  `Falha no upload do áudio para storage (trackId=${trackId}): ${message}`,
                );
                return null;
              })
          : null;
      const persistedAudioUrl =
        uploadedAudioUrl || existing?.meta?.audioUrl || undefined;
      if (uploadedAudioUrl) {
        this.logger.log(
          `uploadAudio: URL persistida em meta.audioUrl — ${uploadedAudioUrl}`,
        );
        await stage('uploadAudio', 'completed', 72, { cacheHit: false });
      } else if (storageProvider === 's3') {
        const errMsg = persistedAudioUrl
          ? 'Upload S3 falhou; mantida URL de áudio existente na faixa.'
          : 'Upload S3 falhou; meta.audioUrl ficará vazio.';
        this.logger.warn(`uploadAudio: ${errMsg} trackId=${trackId}`);
        await stage('uploadAudio', 'failed', 72, { error: errMsg });
      } else {
        await stage('uploadAudio', 'completed', 72, { cacheHit: false });
      }

      const songSlug =
        existing?.slug ??
        (variationOfTrackId
          ? await this.resolveSlugFromBaseTrack(
            artist._id,
            variationOfTrackId,
            trackName,
          )
          : await this.slugService.allocateTrackSlug(artist._id, trackName));

      await stage('resolveYoutube', 'running', 75);
      const coverFromSong = parsed.song?.cover_image_url?.trim();
      const youtubeFromMeta = parsed.song?.youtube_url?.trim();
      const youtubeCacheKey = parsed.song?.title && parsed.song?.artist
        ? `youtube:v2:${parsed.song.title.trim().toLowerCase()}:${parsed.song.artist
          .trim()
          .toLowerCase()}`
        : '';
      const youtubeFromCache = youtubeCacheKey
        ? await this.ingestCache.get<string>(youtubeCacheKey)
        : null;
      const youtubeFromLookup =
        !youtubeFromMeta && parsed.song?.title && parsed.song?.artist
          ? await this.youtubeSearch.findSongVideoUrl({
            title: parsed.song.title,
            artist: parsed.song.artist,
          })
          : null;
      if (youtubeCacheKey && youtubeFromLookup) {
        await this.ingestCache.set(youtubeCacheKey, youtubeFromLookup, 60 * 60 * 24 * 14);
      }
      const youtubeResolved =
        youtubeFromMeta || youtubeFromCache || youtubeFromLookup || undefined;
      await stage('resolveYoutube', 'completed', 82, {
        cacheHit: Boolean(youtubeFromCache),
      });
      /** Variações de utilizador não podem repetir `spotifyId` (índice único na coleção). */
      const spotifyIdForSave = variationOfTrackId
        ? undefined
        : parsed.song?.spotify_track_id?.trim() || undefined;
      await stage('persistTrack', 'running', 88);
      const payload = {
        artistId: artist._id,
        trackId,
        slug: songSlug,
        name: trackName,
        spotifyId: spotifyIdForSave,
        chords,
        sections,
        lyrics,
        lyricsSource,
        meta: this.withUploadedAudioUrl(mergedMeta, persistedAudioUrl),
        userId: auth0Sub,
        owner: auth0Sub,
        variationKey: variationOfTrackId ? auth0Sub : '__base__',
        variationOfTrackId: variationOfTrackId || undefined,
        ...(parsed.variationLabel?.trim()
          ? { variationLabel: parsed.variationLabel.trim().slice(0, 120) }
          : {}),
        ...(variationOfTrackId ? { is_private: true as const } : {}),
        original_tune: resolvedOriginalTune,
        coverImageUrl: coverFromSong || existing?.coverImageUrl,
        ...(parsed.capo_at !== undefined ? { capo_at: parsed.capo_at } : {}),
        youtubeUrl: youtubeResolved || existing?.youtubeUrl,
      };

      if (existing) {
        existing.set(payload);
        if (variationOfTrackId) {
          existing.set('spotifyId', undefined);
        }
        await existing.save();
        this.logger.log(`Track atualizada: ${trackId}`);
        await stage('persistTrack', 'completed', 100);
        return this.loadTrackWithArtist(existing._id);
      }

      const created = await this.trackModel.create(payload);
      this.logger.log(`Track criada: ${trackId}`);
      await stage('persistTrack', 'completed', 100);
      return this.loadTrackWithArtist(created._id);
    } finally {
      // Não bloquear a resposta HTTP: alguns SDKs podem manter o ficheiro aberto brevemente.
      void unlink(tmpPath).catch(() => undefined);
    }
  }

  /**
   * `Document.populate()` após `create`/`save` pode ficar pendente em alguns setups;
   * um `findById` fresco + `lean()` devolve POJO serializável de forma fiável.
   */
  private async loadTrackWithArtist(
    trackObjectId: unknown,
  ): Promise<TrackDocument> {
    const doc = await this.trackModel
      .findById(trackObjectId)
      .populate('artistId')
      .lean()
      .exec();
    if (!doc) {
      throw new InternalServerErrorException(
        'Track não encontrada após persistência.',
      );
    }
    return doc as unknown as TrackDocument;
  }

  /**
   * Garante um artista ligado ao Spotify quando há `spotifyArtistId`; caso contrário faz match por nome.
   * Preenche `slug` em documentos antigos sem slug.
   */
  private async ensureArtist(
    displayName: string,
    spotifyArtistId: string | undefined,
    thumbImageUrl: string | undefined,
  ): Promise<ArtistDocument> {
    const name = displayName.trim() || 'Unknown Artist';

    if (spotifyArtistId) {
      const doc = await this.artistModel
        .findOne({ spotifyId: spotifyArtistId })
        .exec();
      if (doc) {
        if (doc.name !== name) {
          doc.name = name;
        }
        if (thumbImageUrl && doc.thumbImageUrl !== thumbImageUrl) {
          doc.thumbImageUrl = thumbImageUrl;
        }
        if (!doc.slug) {
          doc.slug = await this.slugService.allocateArtistSlug(doc.name);
        }
        await doc.save();
        return doc;
      }
      const slug = await this.slugService.allocateArtistSlug(name);
      return this.artistModel.create({
        name,
        spotifyId: spotifyArtistId,
        slug,
        ...(thumbImageUrl ? { thumbImageUrl } : {}),
      });
    }

    const byName = await this.artistModel.findOne({ name }).exec();
    if (byName) {
      if (thumbImageUrl && byName.thumbImageUrl !== thumbImageUrl) {
        byName.thumbImageUrl = thumbImageUrl;
      }
      if (!byName.slug) {
        byName.slug = await this.slugService.allocateArtistSlug(byName.name);
      }
      await byName.save();
      return byName;
    }

    const slug = await this.slugService.allocateArtistSlug(name);
    return this.artistModel.create({
      name,
      slug,
      ...(thumbImageUrl ? { thumbImageUrl } : {}),
    });
  }

  private async resolveSlugFromBaseTrack(
    artistId: Types.ObjectId,
    baseTrackId: string,
    fallbackName: string,
  ): Promise<string> {
    const base = await this.trackModel
      .findOne({ trackId: baseTrackId })
      .select('slug')
      .lean()
      .exec();
    const slug = typeof base?.slug === 'string' ? base.slug.trim() : '';
    if (slug) return slug;
    return this.slugService.allocateTrackSlug(artistId, fallbackName);
  }

  private mergeTrackMeta(
    parsed: ReturnType<typeof parseIngestMultipartMeta>,
  ): MusicTranscriptionMetaSubdoc | undefined {
    const m: Record<string, unknown> = {};
    if (parsed.transcriptionMeta) Object.assign(m, parsed.transcriptionMeta);
    if (parsed.song) {
      if (!m.name) m.name = parsed.song.title;
      if (m.duration_seconds === undefined && parsed.song.duration_ms != null) {
        m.duration_seconds = parsed.song.duration_ms / 1000;
      }
    }
    return Object.keys(m).length
      ? (m as MusicTranscriptionMetaSubdoc)
      : undefined;
  }

  private withUploadedAudioUrl(
    meta: MusicTranscriptionMetaSubdoc | undefined,
    audioUrl: string | undefined,
  ): MusicTranscriptionMetaSubdoc | undefined {
    const trimmed =
      typeof audioUrl === 'string' && audioUrl.trim() ? audioUrl.trim() : '';
    if (!trimmed) return meta;
    return {
      ...(meta || {}),
      audioUrl: trimmed,
    };
  }

  /** `trackId` é único na coleção; se `preferred` já existir para outro dono, gera sufixo. */
  private async allocateGlobalTrackId(
    preferred: string | undefined,
  ): Promise<string> {
    if (!preferred?.trim()) {
      return `ing_${randomBytes(6).toString('hex')}`;
    }
    const base = preferred
      .replace(/[^\w-]+/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase()
      .slice(0, 80);
    let candidate = base;
    for (let i = 0; i < 12; i++) {
      const clash = await this.trackModel
        .findOne({ trackId: candidate })
        .select('_id')
        .lean()
        .exec();
      if (!clash) return candidate;
      candidate = `${base.slice(0, 72)}_${randomBytes(2).toString('hex')}`;
    }
    return `ing_${randomBytes(8).toString('hex')}`;
  }
}
