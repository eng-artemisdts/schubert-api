import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestCachePort } from './ingest-cache.port';
import { NoopIngestCacheService } from './noop-ingest-cache.service';
import { RedisIngestCacheService } from './redis-ingest-cache.service';

@Module({
  providers: [
    NoopIngestCacheService,
    RedisIngestCacheService,
    {
      provide: IngestCachePort,
      inject: [ConfigService, NoopIngestCacheService, RedisIngestCacheService],
      useFactory: (
        config: ConfigService,
        noop: NoopIngestCacheService,
        redis: RedisIngestCacheService,
      ) => {
        const provider =
          config.get<string>('INGEST_CACHE_PROVIDER')?.trim().toLowerCase() ||
          'redis';
        if (provider === 'redis') return redis;
        return noop;
      },
    },
  ],
  exports: [IngestCachePort],
})
export class IngestCacheModule {}
