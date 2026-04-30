import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';
import { YoutubeSearchPort, YoutubeSongQuery } from './youtube-search.port';

type YoutubeSearchResponse = {
  items?: Array<{ id?: { videoId?: string } }>;
};

@Injectable()
export class YoutubeDataApiSearchService extends YoutubeSearchPort {
  private readonly logger = new Logger(YoutubeDataApiSearchService.name);
  private readonly apiUrl = 'https://www.googleapis.com/youtube/v3/search';

  constructor(private readonly config: ConfigService) {
    super();
  }

  override async findSongVideoUrl(
    query: YoutubeSongQuery,
  ): Promise<string | null> {
    const apiKey = this.config.get<string>('YOUTUBE_DATA_API_KEY')?.trim();
    if (!apiKey) return null;

    const title = query.title?.trim();
    const artist = query.artist?.trim();
    if (!title || !artist) return null;

    const q = `${artist} ${title} official audio`;
    const url = new URL(this.apiUrl);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('videoCategoryId', '10');
    url.searchParams.set('maxResults', '5');
    // Evita retornar vídeos que bloqueiam reprodução em players embutidos.
    url.searchParams.set('videoEmbeddable', 'true');
    // Evita vídeos bloqueados para reprodução fora do youtube.com.
    url.searchParams.set('videoSyndicated', 'true');
    url.searchParams.set('q', q);
    url.searchParams.set('key', apiKey);

    try {
      const res = await undiciFetch(url.toString(), { method: 'GET' });
      if (!res.ok) {
        this.logger.warn(
          `Falha na busca YouTube Data API: ${res.status} ${res.statusText}`,
        );
        return null;
      }
      const data = (await res.json()) as YoutubeSearchResponse;
      const videoId = data.items
        ?.map((item) => item?.id?.videoId?.trim() || '')
        .find((id) => Boolean(id));
      if (!videoId) return null;
      return `https://www.youtube.com/watch?v=${videoId}`;
    } catch (err) {
      this.logger.warn(
        `Erro ao buscar URL no YouTube: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
