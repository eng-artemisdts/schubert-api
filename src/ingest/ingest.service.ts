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
import { InjectModel } from '@nestjs/mongoose';
import { writeFile } from 'fs/promises';
import { Model } from 'mongoose';

import type { IngestCallerLogPayload, IngestBillingPlan } from '../auth/caller-context.util';
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
import { parseIngestMultipartMeta } from './ingest-meta.parser';
import { CHORD_SECTION_PROVIDER, LYRICS_SEARCH_PROVIDER } from './ingest.tokens';
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
    @InjectModel(Artist.name) private readonly artistModel: Model<ArtistDocument>,
    private readonly slugService: SlugService,
  ) {}

  async run(input: IngestRunInput): Promise<TrackDocument> {
    const auth0Sub = input.caller.auth0Sub;
    if (!auth0Sub || auth0Sub.startsWith('(')) {
      throw new UnauthorizedException('Sessão inválida: falta identificador Auth0.');
    }

    const billingPlan: IngestBillingPlan = resolveIngestBillingPlan(input.caller);
    const parsed = parseIngestMultipartMeta(input.metaRaw);

    const tmpPath = join(tmpdir(), `schubert-ingest-${randomBytes(8).toString('hex')}.mp3`);
    await writeFile(tmpPath, input.file.buffer);

    try {
      const { chords, sections, original_tune: workflowOriginalTune } =
        await this.chordSectionProvider.analyze(tmpPath);

      let lyrics: TranscriptionLyricSegmentSubdoc[] = [];
      let lyricsSource: LyricsSource = 'AI';

      const canLrclib = Boolean(parsed.song?.title && parsed.song?.artist);
      if (canLrclib) {
        const song = parsed.song!;
        const durationSec =
          typeof song.duration_ms === 'number' && Number.isFinite(song.duration_ms)
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
          this.logger.log(`Letra LRCLIB: ${match.segments.length} segmento(s).`);
        }
      }

      if (!lyrics.length) {
        const tx = this.transcriptionStrategyFactory.select(billingPlan);
        lyrics = await tx.transcribe(tmpPath, { language: 'pt' });
        lyricsSource = 'AI';
        this.logger.log(
          `Transcrição (${billingPlan === 'free' ? 'Whisper' : 'AudioShake'}): ${lyrics.length} segmento(s).`,
        );
      }

      const mergedMeta = this.mergeTrackMeta(parsed);
      const trackName =
        parsed.song?.title?.trim() ||
        mergedMeta?.name?.trim() ||
        parsed.transcriptionMeta?.name?.trim() ||
        'Untitled';
      const artistName = parsed.song?.artist?.trim() || 'Unknown Artist';

      const primarySpotifyArtistId =
        parsed.song?.spotify_artist_ids?.find((id) => typeof id === 'string' && id.trim())?.trim();
      const artist = await this.ensureArtist(artistName, primarySpotifyArtistId);

      const ownedLookupId = parsed.transcriptionMeta?.trackId?.trim();
      const existing =
        ownedLookupId != null && ownedLookupId !== ''
          ? await this.trackModel.findOne({ trackId: ownedLookupId, owner: auth0Sub }).exec()
          : null;

      const preferredNewId =
        parsed.transcriptionMeta?.trackId?.trim() || parsed.song?.spotify_track_id?.trim();
      const trackId = existing?.trackId ?? (await this.allocateGlobalTrackId(preferredNewId));

      let songSlug = existing?.slug;
      if (!songSlug) {
        songSlug = await this.slugService.allocateTrackSlug(artist._id, trackName);
      }

      const payload = {
        artistId: artist._id,
        trackId,
        slug: songSlug,
        name: trackName,
        spotifyId: parsed.song?.spotify_track_id?.trim() || undefined,
        chords,
        sections,
        lyrics,
        lyricsSource,
        meta: mergedMeta,
        userId: auth0Sub,
        owner: auth0Sub,
        original_tune: workflowOriginalTune.trim(),
      };

      if (existing) {
        existing.set(payload);
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
  private async loadTrackWithArtist(trackObjectId: unknown): Promise<TrackDocument> {
    const doc = await this.trackModel
      .findById(trackObjectId)
      .populate('artistId')
      .lean()
      .exec();
    if (!doc) {
      throw new InternalServerErrorException('Track não encontrada após persistência.');
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
      let doc = await this.artistModel.findOne({ spotifyId: spotifyArtistId }).exec();
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
      return this.artistModel.create({ name, spotifyId: spotifyArtistId, slug });
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

  private mergeTrackMeta(parsed: ReturnType<typeof parseIngestMultipartMeta>): MusicTranscriptionMetaSubdoc | undefined {
    const m: Record<string, unknown> = {};
    if (parsed.transcriptionMeta) Object.assign(m, parsed.transcriptionMeta);
    if (parsed.song) {
      if (!m.name) m.name = parsed.song.title;
      if (m.duration_seconds === undefined && parsed.song.duration_ms != null) {
        m.duration_seconds = parsed.song.duration_ms / 1000;
      }
    }
    return Object.keys(m).length ? (m as MusicTranscriptionMetaSubdoc) : undefined;
  }

  /** `trackId` é único na coleção; se `preferred` já existir para outro dono, gera sufixo. */
  private async allocateGlobalTrackId(preferred: string | undefined): Promise<string> {
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
      const clash = await this.trackModel.findOne({ trackId: candidate }).select('_id').lean().exec();
      if (!clash) return candidate;
      candidate = `${base.slice(0, 72)}_${randomBytes(2).toString('hex')}`;
    }
    return `ing_${randomBytes(8).toString('hex')}`;
  }
}
