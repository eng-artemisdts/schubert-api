import { randomBytes } from 'crypto';
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

export type IngestRunInput = {
  file: Express.Multer.File;
  metaRaw: unknown;
  caller: IngestCallerLogPayload;
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
  ) {}

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

    const tmpPath = join(
      tmpdir(),
      `schubert-ingest-${randomBytes(8).toString('hex')}.mp3`,
    );
    await writeFile(tmpPath, input.file.buffer);

    try {
      const {
        chords,
        sections,
        original_tune: workflowOriginalTune,
      } = await this.chordSectionProvider.analyze(tmpPath);

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

      const lyricsSearchDisabled = this.isLyricsSearchDisabled();
      const canLrclib =
        !lyricsSearchDisabled &&
        Boolean(parsed.song?.title && parsed.song?.artist);
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
        const tx = this.transcriptionStrategyFactory.select(billingPlan);
        lyrics = await tx.transcribe(tmpPath, { language: 'pt' });
        lyricsSource = 'AI';
        this.logger.log(
          `Transcrição (AudioShake): ${lyrics.length} segmento(s).`,
        );
      }

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
      const artist = await this.ensureArtist(
        artistName,
        primarySpotifyArtistId,
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

      const songSlug =
        existing?.slug ??
        (variationOfTrackId
          ? await this.resolveSlugFromBaseTrack(
              artist._id,
              variationOfTrackId,
              trackName,
            )
          : await this.slugService.allocateTrackSlug(artist._id, trackName));

      const coverFromSong = parsed.song?.cover_image_url?.trim();
      /** Variações de utilizador não podem repetir `spotifyId` (índice único na coleção). */
      const spotifyIdForSave = variationOfTrackId
        ? undefined
        : parsed.song?.spotify_track_id?.trim() || undefined;
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
        meta: mergedMeta,
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
      };

      if (existing) {
        existing.set(payload);
        if (variationOfTrackId) {
          existing.set('spotifyId', undefined);
        }
        await existing.save();
        this.logger.log(`Track atualizada: ${trackId}`);
        return this.loadTrackWithArtist(existing._id);
      }

      const created = await this.trackModel.create(payload);
      this.logger.log(`Track criada: ${trackId}`);
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
  ): Promise<ArtistDocument> {
    const name = displayName.trim() || 'Unknown Artist';

    if (spotifyArtistId) {
      const doc = await this.artistModel
        .findOne({ spotifyId: spotifyArtistId })
        .exec();
      if (doc) {
        if (doc.name !== name) {
          doc.name = name;
          await doc.save();
        }
        if (!doc.slug) {
          doc.slug = await this.slugService.allocateArtistSlug(doc.name);
          await doc.save();
        }
        return doc;
      }
      const slug = await this.slugService.allocateArtistSlug(name);
      return this.artistModel.create({
        name,
        spotifyId: spotifyArtistId,
        slug,
      });
    }

    const byName = await this.artistModel.findOne({ name }).exec();
    if (byName) {
      if (!byName.slug) {
        byName.slug = await this.slugService.allocateArtistSlug(byName.name);
        await byName.save();
      }
      return byName;
    }

    const slug = await this.slugService.allocateArtistSlug(name);
    return this.artistModel.create({ name, slug });
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
