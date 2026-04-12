import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ArtistDocument = HydratedDocument<Artist>;

@Schema({ collection: 'artists', timestamps: true })
export class Artist {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true, sparse: true, unique: true })
  spotifyId?: string;
}

export const ArtistSchema = SchemaFactory.createForClass(Artist);
