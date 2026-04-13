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
  MusicTranscriptionMetaSubdoc,
  TranscriptionLyricSegmentSubdoc,
} from '../tracks/schemas/track.schema';
import { Artist, ArtistDocument } from '../artists/schemas/artist.schema';
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

      const lyricsVariants: {
        ai?: TranscriptionLyricSegmentSubdoc[];
        match?: TranscriptionLyricSegmentSubdoc[];
      } = {};

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
          lyricsVariants.match = match.segments;
          this.logger.log(`Letra LRCLIB: ${match.segments.length} segmento(s).`);
        }
      }

      if (!lyricsVariants.match?.length) {
        const tx = this.transcriptionStrategyFactory.select(billingPlan);
        lyricsVariants.ai = await tx.transcribe(tmpPath, { language: 'pt' });
        this.logger.log(
          `Transcrição (${billingPlan === 'free' ? 'Whisper' : 'AudioShake'}): ${lyricsVariants.ai.length} segmento(s).`,
        );
      }

      const mergedMeta = this.mergeTrackMeta(parsed);
      const trackName =
        parsed.song?.title?.trim() ||
        mergedMeta?.name?.trim() ||
        parsed.transcriptionMeta?.name?.trim() ||
        'Untitled';
      const artistName = parsed.song?.artist?.trim() || 'Unknown Artist';

      const artist = await this.ensureArtist(artistName);

      const ownedLookupId = parsed.transcriptionMeta?.trackId?.trim();
      const existing =
        ownedLookupId != null && ownedLookupId !== ''
          ? await this.trackModel.findOne({ trackId: ownedLookupId, owner: auth0Sub }).exec()
          : null;

      const preferredNewId =
        parsed.transcriptionMeta?.trackId?.trim() || parsed.song?.spotify_track_id?.trim();
      const trackId = existing?.trackId ?? (await this.allocateGlobalTrackId(preferredNewId));

      const payload = {
        artistId: artist._id,
        trackId,
        name: trackName,
        spotifyId: parsed.song?.spotify_track_id?.trim() || undefined,
        chords,
        sections,
        lyricsVariants,
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

  private async ensureArtist(displayName: string): Promise<ArtistDocument> {
    const name = displayName.trim() || 'Unknown Artist';
    const found = await this.artistModel.findOne({ name }).exec();
    if (found) return found;
    return this.artistModel.create({ name });
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
