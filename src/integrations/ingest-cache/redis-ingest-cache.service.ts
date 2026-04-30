import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { IngestCachePort } from './ingest-cache.port';

@Injectable()
export class RedisIngestCacheService extends IngestCachePort {
  private readonly logger = new Logger(RedisIngestCacheService.name);
  private readonly redis: Redis | null;

  constructor(private readonly config: ConfigService) {
    super();
    const url = this.config.get<string>('REDIS_URL')?.trim();
    this.redis = url ? new Redis(url, { maxRetriesPerRequest: 1 }) : null;
  }

  override async get<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(
        `Falha cache get ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  override async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', Math.max(1, ttlSec));
    } catch (err) {
      this.logger.warn(
        `Falha cache set ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
