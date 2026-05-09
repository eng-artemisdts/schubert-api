import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';

import { SpotifyMetadataPort, SpotifyTrackMeta } from './spotify-metadata.port';

type SpotifyTokenResponse = { access_token: string; expires_in: number };

type SpotifyTrackResponse = {
  id: string;
  name: string;
  duration_ms: number;
  artists: { id: string; name: string }[];
  album: {
    name: string;
    images: { url: string; width?: number; height?: number }[];
  };
};

@Injectable()
export class SpotifyMetadataService extends SpotifyMetadataPort {
  private readonly logger = new Logger(SpotifyMetadataService.name);
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {
    super();
  }

  override async getTrackMeta(spotifyUrl: string): Promise<SpotifyTrackMeta | null> {
    const trackId = this.extractTrackId(spotifyUrl);
    if (!trackId) {
      this.logger.warn(`URL Spotify inválida: ${spotifyUrl}`);
      return null;
    }

    const token = await this.getAccessToken();
    if (!token) return null;

    try {
      const res = await undiciFetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        this.logger.warn(`Spotify API: ${res.status} ${res.statusText}`);
        return null;
      }
      const data = (await res.json()) as SpotifyTrackResponse;

      const images = data.album?.images ?? [];
      const bestImage = [...images].sort(
        (a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
      )[0];

      return {
        spotifyTrackId: data.id,
        title: data.name,
        artist: data.artists.map((a) => a.name).join(', '),
        album: data.album?.name ?? '',
        durationMs: data.duration_ms,
        coverImageUrl: bestImage?.url?.trim() || undefined,
        spotifyArtistIds: data.artists.map((a) => a.id).filter(Boolean),
      };
    } catch (err) {
      this.logger.warn(`Falha ao buscar metadata Spotify: ${(err as Error).message}`);
      return null;
    }
  }

  private extractTrackId(url: string): string | null {
    const match = url.match(/spotify\.com\/(?:intl-[a-z]+\/)?track\/([a-zA-Z0-9]+)/);
    return match?.[1] ?? null;
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.value;
    }

    const clientId = this.config.get<string>('SPOTIFY_CLIENT_ID')?.trim();
    const clientSecret = this.config.get<string>('SPOTIFY_CLIENT_SECRET')?.trim();
    if (!clientId || !clientSecret) {
      this.logger.warn('SPOTIFY_CLIENT_ID ou SPOTIFY_CLIENT_SECRET não configurados.');
      return null;
    }

    try {
      const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const res = await undiciFetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      if (!res.ok) return null;
      const data = (await res.json()) as SpotifyTokenResponse;
      this.cachedToken = {
        value: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      };
      return data.access_token;
    } catch (err) {
      this.logger.warn(`Falha ao obter token Spotify: ${(err as Error).message}`);
      return null;
    }
  }
}
