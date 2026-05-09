import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class IngestUrlDto {
  @IsUrl({ require_protocol: true }, { message: 'sourceUrl deve ser uma URL válida com protocolo.' })
  @MaxLength(2048)
  sourceUrl: string;

  /**
   * Mesmos campos opcionais do meta atual.
   * O front pode enviar metadados Spotify pré-buscados para evitar uma chamada extra.
   */
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  artist?: string;

  @IsOptional()
  @IsString()
  album?: string;

  @IsOptional()
  @IsString()
  spotifyTrackId?: string;

  @IsOptional()
  @IsString()
  coverImageUrl?: string;

  @IsOptional()
  @IsString()
  variationOfTrackId?: string;
}
