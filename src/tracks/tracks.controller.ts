import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import type { JwtAuthUser } from '../auth/jwt.strategy';
import { MusicRecognitionPort } from '../integrations/music-recognition/music-recognition.port';
import { TrackIdentifyResponseDto } from './dto/track-identify-response.dto';
import { TracksService } from './tracks.service';

/** Limite da API AudD: ~10 MB e ~25 s de áudio; acima disso o servidor corta a ligação (ex.: `EPIPE` no cliente). */
const MAX_BYTES = 10 * 1024 * 1024;

function isMp3Upload(file: Express.Multer.File): boolean {
  const name = (file.originalname ?? '').toLowerCase();
  const mime = (file.mimetype ?? '').toLowerCase();
  const mp3Ext = name.endsWith('.mp3');
  const mp3Mime = mime === 'audio/mpeg' || mime === 'audio/mp3';
  return mp3Ext || mp3Mime;
}

type RequestWithJwtUser = Request & { user?: JwtAuthUser };

@Controller('tracks')
export class TracksController {
  constructor(
    private readonly recognition: MusicRecognitionPort,
    private readonly tracks: TracksService,
  ) { }

  /**
   * Devolve o documento `Track` (com `artistId` populado) por `trackId` ou `spotifyId`.
   */
  @Get('by-key/:key')
  async findByKey(@Param('key') key: string) {
    const track = await this.tracks.findByPublicKey(key);
    if (!track) {
      throw new NotFoundException(`Nenhuma faixa com a chave «${key}».`);
    }
    return track.toJSON();
  }

  /**
   * Upload an MP3 snippet; recognize via AudD (behind {@link MusicRecognitionPort});
   * if the song exists in our `tracks` collection, return it.
   */
  @Post('identify')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BYTES },
    }),
  )
  async identify(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<TrackIdentifyResponseDto> {
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        'Envie um ficheiro MP3 no campo multipart `file`.',
      );
    }

    if (!isMp3Upload(file)) {
      throw new BadRequestException(
        'Apenas ficheiros .mp3 são aceites para identificação.',
      );
    }

    const song = await this.recognition.recognizeFromAudioBuffer({
      buffer: file.buffer,
      filename: file.originalname || 'upload.mp3',
      mimeType: file.mimetype || 'audio/mpeg',
    });

    if (!song) {
      return { recognized: false, song: null, track: null };
    }

    const track = await this.tracks.findConfiguredTrackForRecognition(song);
    return {
      recognized: true,
      song,
      track: track
        ? (track.toJSON() as unknown as Record<string, unknown>)
        : null,
    };
  }

  /**
   * Atualização parcial de acordes, `lyricsVariants` e/ou `sections` (apenas dono da faixa).
   */
  @Patch('by-key/:key')
  async patchByKey(
    @Param('key') key: string,
    @Req() req: RequestWithJwtUser,
    @Body()
    body: {
      chords?: unknown;
      lyricsVariants?: Record<string, unknown>;
      sections?: unknown;
    },
  ) {
    const sub = req.user?.sub;
    if (!sub?.trim()) {
      throw new UnauthorizedException('Sessão inválida: falta identificador Auth0.');
    }
    const doc = await this.tracks.updateTranscriptionByPublicKey(key.trim(), sub.trim(), {
      chords: body.chords,
      lyricsVariants: body.lyricsVariants,
      sections: body.sections,
    });
    return doc.toJSON();
  }

}
