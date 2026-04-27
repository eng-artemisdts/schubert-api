import { Module } from '@nestjs/common';
import { YoutubeDataApiSearchService } from './youtube-data-api-search.service';
import { YoutubeSearchPort } from './youtube-search.port';

@Module({
  providers: [
    YoutubeDataApiSearchService,
    {
      provide: YoutubeSearchPort,
      useExisting: YoutubeDataApiSearchService,
    },
  ],
  exports: [YoutubeSearchPort],
})
export class YoutubeSearchModule {}
