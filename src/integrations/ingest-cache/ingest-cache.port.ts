export abstract class IngestCachePort {
  abstract get<T>(key: string): Promise<T | null>;
  abstract set<T>(key: string, value: T, ttlSec: number): Promise<void>;
}
