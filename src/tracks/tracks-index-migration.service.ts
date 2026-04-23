import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Track, TrackDocument } from './schemas/track.schema';

/** Índice único antigo (antes das variações); conflita com a mesma slug na base e na variação. */
const LEGACY_UNIQUE_ARTIST_SLUG = 'artistId_1_slug_1';

/**
 * No arranque: remove o índice legado, preenche `variationKey` em documentos antigos e sincroniza índices com o schema.
 */
@Injectable()
export class TracksIndexMigrationService implements OnModuleInit {
  private readonly logger = new Logger(TracksIndexMigrationService.name);

  constructor(
    @InjectModel(Track.name) private readonly trackModel: Model<TrackDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.dropLegacySlugUniqueIndexIfPresent();
    await this.backfillBaseVariationKey();
    await this.syncTrackIndexes();
  }

  private async dropLegacySlugUniqueIndexIfPresent(): Promise<void> {
    try {
      const coll = this.trackModel.collection;
      const indexes = await coll.indexes();
      const hasLegacy = indexes.some(
        (idx) => idx.name === LEGACY_UNIQUE_ARTIST_SLUG,
      );
      if (!hasLegacy) return;
      await coll.dropIndex(LEGACY_UNIQUE_ARTIST_SLUG);
      this.logger.log(
        `Removido índice legado «${LEGACY_UNIQUE_ARTIST_SLUG}» — variações podem partilhar slug com a cifra base.`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `Drop do índice legado ignorado ou falhou (pode já estar ausente): ${msg}`,
      );
    }
  }

  private async backfillBaseVariationKey(): Promise<void> {
    try {
      const res = await this.trackModel.updateMany(
        { $or: [{ variationKey: { $exists: false } }, { variationKey: null }] },
        { $set: { variationKey: '__base__' } },
      );
      if (res.modifiedCount > 0) {
        this.logger.log(
          `Backfill: variationKey=__base__ em ${res.modifiedCount} documento(s).`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Backfill variationKey falhou: ${msg}`);
    }
  }

  private async syncTrackIndexes(): Promise<void> {
    await this.trackModel.syncIndexes();
    this.logger.log(
      'Índices do modelo Track alinhados ao schema (unique por artistId + slug + variationKey).',
    );
  }
}
