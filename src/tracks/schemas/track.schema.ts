import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { Artist } from '../../artists/schemas/artist.schema';

export type TrackDocument = HydratedDocument<Track>;

@Schema({ _id: false })
export class TranscriptionChordEventSubdoc {
  @Prop({ required: true }) start: number;
  @Prop({ required: true }) end: number;
  @Prop({ required: true }) start_bar: number;
  @Prop({ required: true }) start_beat: number;
  @Prop({ required: true }) end_bar: number;
  @Prop({ required: true }) end_beat: number;
  @Prop({ required: true }) chord_majmin: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) bass:
    | string
    | null;
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  bass_nashville: string | null;
  @Prop({ required: true }) chord_complex_jazz: string;
  @Prop({ required: true }) chord_simple_jazz: string;
  @Prop({ required: true }) chord_basic_jazz: string;
  @Prop({ required: true }) chord_complex_pop: string;
  @Prop({ required: true }) chord_simple_pop: string;
  @Prop({ required: true }) chord_basic_pop: string;
  @Prop({ required: true }) chord_complex_nashville: string;
  @Prop({ required: true }) chord_simple_nashville: string;
  @Prop({ required: true }) chord_basic_nashville: string;
}

const TranscriptionChordEventSchema = SchemaFactory.createForClass(
  TranscriptionChordEventSubdoc,
);

@Schema({ _id: false })
export class TranscriptionLyricSyllableSubdoc {
  @Prop({ required: true }) syllable: string;
  @Prop({ required: true }) start: number;
  @Prop({ required: true }) end: number;
}

const TranscriptionLyricSyllableSchema = SchemaFactory.createForClass(
  TranscriptionLyricSyllableSubdoc,
);

@Schema({ _id: false })
export class TranscriptionLyricWordSubdoc {
  @Prop({ required: true }) word: string;
  @Prop() start?: number;
  @Prop() end?: number;
  @Prop({ type: [TranscriptionLyricSyllableSchema], default: undefined })
  syllables?: TranscriptionLyricSyllableSubdoc[];
}

const TranscriptionLyricWordSchema = SchemaFactory.createForClass(
  TranscriptionLyricWordSubdoc,
);

@Schema({ _id: false })
export class TranscriptionLyricSegmentSubdoc {
  @Prop() start?: number;
  @Prop() end?: number;
  @Prop() text?: string;
  @Prop() language?: string;
  @Prop({ type: [TranscriptionLyricWordSchema], default: undefined })
  words?: TranscriptionLyricWordSubdoc[];
}

const TranscriptionLyricSegmentSchema = SchemaFactory.createForClass(
  TranscriptionLyricSegmentSubdoc,
);

@Schema({ _id: false })
export class TranscriptionLyricsVariantsSubdoc {
  @Prop({ type: [TranscriptionLyricSegmentSchema], default: undefined })
  ai?: TranscriptionLyricSegmentSubdoc[];

  @Prop({ type: [TranscriptionLyricSegmentSchema], default: undefined })
  match?: TranscriptionLyricSegmentSubdoc[];
}

const TranscriptionLyricsVariantsSchema = SchemaFactory.createForClass(
  TranscriptionLyricsVariantsSubdoc,
);

@Schema({ _id: false })
export class TranscriptionSectionSubdoc {
  @Prop({ required: true }) start: number;
  @Prop({ required: true }) end: number;
  @Prop({ required: true }) label: string;
}

const TranscriptionSectionSchema = SchemaFactory.createForClass(
  TranscriptionSectionSubdoc,
);

@Schema({ _id: false })
export class MusicTranscriptionMetaSubdoc {
  @Prop() id?: string;
  @Prop() name?: string;
  @Prop() sourcePathParam?: string;
  @Prop() trackId?: string;
  @Prop() lyricsVariant?: string;
  @Prop() audioUrl?: string;
  @Prop() duration_seconds?: number;
}

const MusicTranscriptionMetaSchema = SchemaFactory.createForClass(
  MusicTranscriptionMetaSubdoc,
);

@Schema({ collection: 'tracks', timestamps: true })
export class Track {
  @Prop({ type: Types.ObjectId, ref: Artist.name, required: true, index: true })
  artistId: Types.ObjectId;

  /** Identificador da pasta em media/transcriptions (ex.: whistle, all_i_need). */
  @Prop({ trim: true, sparse: true, unique: true })
  trackId?: string;

  @Prop({ trim: true, required: false })
  name?: string;

  @Prop({ trim: true, sparse: true, unique: true })
  spotifyId?: string;

  /** Afinação de referência (ex.: standard, drop_d). */
  @Prop({ trim: true, required: false })
  standard_tune?: string;

  /** Referência ao utilizador Auth0 (`sub`) que criou esta versão da cifra. */
  @Prop({ trim: true, index: true })
  userId?: string;

  /** Afinação original da cifra (texto livre para a sidebar, ex.: «E standard»). */
  @Prop({ trim: true, default: '' })
  original_tune?: string;

  /** Traste do capo (0 = sem capo). */
  @Prop({ default: 0 })
  capo_at?: number;

  @Prop({ default: false, index: true })
  is_private?: boolean;

  @Prop({ type: [TranscriptionChordEventSchema], default: [] })
  chords: TranscriptionChordEventSubdoc[];

  @Prop({ type: TranscriptionLyricsVariantsSchema, required: false })
  lyricsVariants?: TranscriptionLyricsVariantsSubdoc;

  @Prop({ type: [TranscriptionSectionSchema], default: [] })
  sections: TranscriptionSectionSubdoc[];

  @Prop({ type: MusicTranscriptionMetaSchema, required: false })
  meta?: MusicTranscriptionMetaSubdoc;

  @Prop({ required: false })
  chordTimeOffsetSec?: number;
}

export const TrackSchema = SchemaFactory.createForClass(Track);
