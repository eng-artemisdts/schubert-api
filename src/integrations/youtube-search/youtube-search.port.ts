export type YoutubeSongQuery = {
  title: string;
  artist: string;
};

/**
 * Porta para localizar URL de vídeo no YouTube a partir de metadados de música.
 * Implementações não devem vazar payload específico do fornecedor.
 */
export abstract class YoutubeSearchPort {
  abstract findSongVideoUrl(query: YoutubeSongQuery): Promise<string | null>;
}
