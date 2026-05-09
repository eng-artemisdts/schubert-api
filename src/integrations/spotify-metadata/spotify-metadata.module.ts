import { Module } from '@nestjs/common';

import { SpotifyMetadataPort } from './spotify-metadata.port';
import { SpotifyMetadataService } from './spotify-metadata.service';

@Module({
  providers: [{ provide: SpotifyMetadataPort, useClass: SpotifyMetadataService }],
  exports: [SpotifyMetadataPort],
})
export class SpotifyMetadataModule {}
