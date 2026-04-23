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
import { Public } from '../auth/public.decorator';
import type { JwtAuthUser } from '../auth/jwt.strategy';
import { MusicRecognitionPort } from '../integrations/music-recognition/music-recognition.port';
import { TrackIdentifyResponseDto } from './dto/track-identify-response.dto';
import { MAX_MP3_UPLOAD_BYTES } from '../upload-limits.constants';
import { TracksService } from './tracks.service';

/** Multer — mesmo limite que o cliente; o envio à AudD usa só ~25 s após truncagem no serviço de reconhecimento. */
const IDENTIFY_UPLOAD_LIMIT_BYTES = MAX_MP3_UPLOAD_BYTES;

function isMp3Upload(file: Express.Multer.File): boolean {
  const name = (file.originalname ?? '').toLowerCase();
  const mime = (file.mimetype ?? '').toLowerCase();
  const mp3Ext = name.endsWith('.mp3');
  const mp3Mime = mime === 'audio/mpeg' || mime === 'audio/mp3';
  return mp3Ext || mp3Mime;
}

type RequestWithJwtUser = Request & { user?: JwtAuthUser };

function isTrackAuth0Owner(
  track: { owner?: unknown; userId?: unknown } | null | undefined,
  sub: string,
): boolean {
  if (!track || !sub.trim()) return false;
  const owner =
    typeof track.owner === 'string' && track.owner.trim()
      ? track.owner.trim()
      : typeof track.userId === 'string' && track.userId.trim()
        ? track.userId.trim()
        : '';
  return Boolean(owner && owner === sub.trim());
}

@Controller('tracks')
export class TracksController {
  constructor(
    private readonly recognition: MusicRecognitionPort,
    private readonly tracks: TracksService,
  ) {}

  /**
   * Devolve o documento `Track` (com `artistId` populado) por slugs do artista e da música.
   * Leitura pública (sem JWT); escrita continua em PATCH com dono.
   */
  @Public()
  @Get('by-slug/:artistSlug/:songSlug')
  async findBySlug(
    @Param('artistSlug') artistSlug: string,
    @Param('songSlug') songSlug: string,
    @Req() req: RequestWithJwtUser,
  ) {
    const viewerSub = req.user?.sub?.trim() || undefined;
    const found = await this.tracks.findTrackAndVariationsBySlugs(
      artistSlug,
      songSlug,
      viewerSub,
    );
    const track = found?.track ?? null;
    if (!track) {
      throw new NotFoundException(
        `Nenhuma faixa com os slugs «${artistSlug}» / «${songSlug}».`,
      );
    }
    return {
      ...track.toJSON(),
      variations: (found?.variations ?? []).map((variation) =>
        variation.toJSON(),
      ),
    };
  }

  /**
   * Devolve o documento `Track` (com `artistId` populado) por `trackId` ou `spotifyId`.
   * Leitura pública (sem JWT).
   */
  @Public()
  @Get('by-key/:key')
  async findByKey(@Param('key') key: string, @Req() req: RequestWithJwtUser) {
    const viewerSub = req.user?.sub?.trim() || undefined;
    const track = await this.tracks.findByPublicKey(key, viewerSub);
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
      limits: {
        fileSize: IDENTIFY_UPLOAD_LIMIT_BYTES,
      },
    }),
  )
  async identify(
    @Req() req: RequestWithJwtUser,
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

    const viewerSub = req.user?.sub?.trim() || '';
    const track = await this.tracks.findConfiguredTrackForRecognition(song);
    const referenceKey =
      track?.trackId?.trim() || track?.spotifyId?.trim() || '';
    const preferredTrack =
      track && viewerSub && referenceKey
        ? await this.tracks.findByPublicKey(referenceKey, viewerSub)
        : track;
    const variationKey = (track as unknown as { variationKey?: string } | null)
      ?.variationKey;
    const isCanonicalBase =
      variationKey === '__base__' ||
      variationKey === undefined ||
      variationKey === '';
    /** Dono da cifra base (documento catalogado): só “Editar”; visitantes podem “Criar variação”. */
    const isOwnerOfBaseChord = isTrackAuth0Owner(track, viewerSub);
    const canEditTrack = isTrackAuth0Owner(
      preferredTrack as unknown as { owner?: unknown; userId?: unknown },
      viewerSub,
    );
    return {
      recognized: true,
      song,
      track: preferredTrack
        ? (preferredTrack.toJSON() as unknown as Record<string, unknown>)
        : null,
      canEditTrack,
      canCreateVariation: Boolean(
        viewerSub &&
        track &&
        preferredTrack &&
        !isOwnerOfBaseChord &&
        String(track._id) === String(preferredTrack._id) &&
        isCanonicalBase,
      ),
    };
  }

  /**
   * Atualização parcial por slugs (`/cifras/:artistSlug/:songSlug`).
   */
  @Patch('by-slug/:artistSlug/:songSlug')
  async patchBySlug(
    @Param('artistSlug') artistSlug: string,
    @Param('songSlug') songSlug: string,
    @Req() req: RequestWithJwtUser,
    @Body()
    body: {
      chords?: unknown;
      lyrics?: unknown;
      lyricsSource?: 'AI' | 'MATCH';
      sections?: unknown;
      variationLabel?: unknown;
      is_private?: unknown;
    },
  ) {
    const sub = req.user?.sub;
    if (!sub?.trim()) {
      throw new UnauthorizedException(
        'Sessão inválida: falta identificador Auth0.',
      );
    }
    const doc = await this.tracks.updateTranscriptionBySlugs(
      artistSlug.trim(),
      songSlug.trim(),
      sub.trim(),
      {
        chords: body.chords,
        lyrics: body.lyrics,
        lyricsSource: body.lyricsSource,
        sections: body.sections,
        variationLabel: body.variationLabel,
        is_private: body.is_private,
      },
    );
    return doc.toJSON();
  }

  /**
   * Atualização parcial de acordes, `lyrics`, `lyricsSource` e/ou `sections` (apenas dono da faixa).
   */
  @Patch('by-key/:key')
  async patchByKey(
    @Param('key') key: string,
    @Req() req: RequestWithJwtUser,
    @Body()
    body: {
      chords?: unknown;
      lyrics?: unknown;
      lyricsSource?: 'AI' | 'MATCH';
      sections?: unknown;
      variationLabel?: unknown;
      is_private?: unknown;
    },
  ) {
    const sub = req.user?.sub;
    if (!sub?.trim()) {
      throw new UnauthorizedException(
        'Sessão inválida: falta identificador Auth0.',
      );
    }
    const doc = await this.tracks.updateTranscriptionByPublicKey(
      key.trim(),
      sub.trim(),
      {
        chords: body.chords,
        lyrics: body.lyrics,
        lyricsSource: body.lyricsSource,
        sections: body.sections,
        variationLabel: body.variationLabel,
        is_private: body.is_private,
      },
    );
    return doc.toJSON();
  }
}
