/** Normalized result of a third-party music recognition call (provider-agnostic). */
export type RecognizedSongDto = {
  title: string;
  artist: string;
  album: string;
  release_date: string;
  label: string;
  timecode: string;
  song_link: string;
  spotify_track_id?: string;
  spotify_artist_ids: string[];
  duration_ms?: number;
  /** URL HTTP da arte do álbum, quando o fornecedor a envia (ex.: Spotify / Apple Music). */
  cover_image_url?: string;
};
