export type SpotifyTrackMeta = {
  spotifyTrackId: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  coverImageUrl?: string;
  spotifyArtistIds: string[];
};

export abstract class SpotifyMetadataPort {
  abstract getTrackMeta(spotifyUrl: string): Promise<SpotifyTrackMeta | null>;
}
