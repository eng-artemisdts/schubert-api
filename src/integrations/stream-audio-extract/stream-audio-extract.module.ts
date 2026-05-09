import { Module } from '@nestjs/common';

import { StreamAudioExtractPort } from './stream-audio-extract.port';
import { YtDlpAudioExtractService } from './yt-dlp-audio-extract.service';

@Module({
  providers: [
    {
      provide: StreamAudioExtractPort,
      useClass: YtDlpAudioExtractService,
    },
  ],
  exports: [StreamAudioExtractPort],
})
export class StreamAudioExtractModule {}
