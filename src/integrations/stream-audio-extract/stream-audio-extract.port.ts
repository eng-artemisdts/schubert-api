export type StreamAudioExtractInput = {
  /** URL original enviada pelo utilizador */
  sourceUrl: string;
  /** Formato de saída desejado */
  audioFormat?: 'mp3' | 'wav';
};

export type StreamAudioExtractResult = {
  /** Buffer de áudio extraído */
  buffer: Buffer;
  /** Formato efetivo do ficheiro */
  mimeType: string;
  /** Nome sugerido para o ficheiro */
  fileName: string;
  /** Título detectado pelo extrator */
  title?: string;
  /** Duração em segundos, se disponível */
  durationSec?: number;
  /** Uploader/canal, se disponível */
  uploader?: string;
};

/**
 * Porta para extração temporária de áudio a partir de uma URL de média social.
 * Implementações devem extrair, converter e retornar o buffer — sem armazenamento permanente.
 */
export abstract class StreamAudioExtractPort {
  abstract extract(input: StreamAudioExtractInput): Promise<StreamAudioExtractResult>;
}
