import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';

import { buildIngestCallerLogPayload } from '../auth/caller-context.util';
import type { JwtAuthUser } from '../auth/jwt.strategy';
import type { TrackDocument } from '../tracks/schemas/track.schema';
import { IngestService } from './ingest.service';

function trackToJson(track: TrackDocument): Record<string, unknown> {
  const t = track as unknown as { toJSON?: () => Record<string, unknown> };
  if (typeof t.toJSON === 'function') {
    return t.toJSON();
  }
  return track as unknown as Record<string, unknown>;
}

type RequestWithJwtUser = Request & { user?: JwtAuthUser };

const MAX_BYTES = 10 * 1024 * 1024;

function isMp3Upload(file: Express.Multer.File): boolean {
  const name = (file.originalname ?? '').toLowerCase();
  const mime = (file.mimetype ?? '').toLowerCase();
  return name.endsWith('.mp3') || mime === 'audio/mpeg' || mime === 'audio/mp3';
}

@Controller('tracks')
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BYTES },
    }),
  )
  async ingest(
    @Req() req: RequestWithJwtUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('meta') metaRaw?: string | Record<string, unknown>,
  ) {
    console.log('[tracks/ingest] chamador', buildIngestCallerLogPayload(req, req.user));

    if (!file?.buffer?.length) {
      throw new BadRequestException('Envie um ficheiro MP3 no campo multipart `file`.');
    }
    if (!isMp3Upload(file)) {
      throw new BadRequestException('Apenas ficheiros .mp3 são aceites para ingestão.');
    }

    const track = await this.ingestService.run({
      file,
      metaRaw,
      caller: buildIngestCallerLogPayload(req, req.user),
    });

    return { track: trackToJson(track) };
  }
}
