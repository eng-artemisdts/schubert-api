import { Injectable } from '@nestjs/common';
import { IngestCachePort } from './ingest-cache.port';

@Injectable()
export class NoopIngestCacheService extends IngestCachePort {
  override async get<T>(_key: string): Promise<T | null> {
    return null;
  }
  override async set<T>(_key: string, _value: T, _ttlSec: number): Promise<void> {}
}
