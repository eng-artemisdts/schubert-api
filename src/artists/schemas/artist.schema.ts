import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ArtistDocument = HydratedDocument<Artist>;

@Schema({ collection: 'artists', timestamps: true })
export class Artist {
  @Prop({ required: true, trim: true })
  name: string;

  /** Slug URL (minúsculas, hífens), derivado do nome. */
  @Prop({ trim: true, sparse: true, unique: true })
  slug?: string;

  @Prop({ trim: true, sparse: true, unique: true })
  spotifyId?: string;

  /** Thumbnail para catálogos por artista (ex.: imagem de capa retornada na identificação). */
  @Prop({ trim: true, required: false })
  thumbImageUrl?: string;
}

export const ArtistSchema = SchemaFactory.createForClass(Artist);
