// src/cache/index.ts
//
// Small in-process LRU cache with per-key TTL, tag-based invalidation and
// hit/miss counters. Designed to be used by API replicas together with a
// Postgres LISTEN connection that calls `invalidateTag` / `flush` when
// NOTIFY messages arrive. If the LISTEN connection is down, staleness is
// bounded by the per-key TTL.

export interface CacheEntryOptions {
  /** Time-to-live in milliseconds. Defaults to the cache's default TTL. */
  ttlMs?: number;
  /** Tags associated with this entry, used for tag-based invalidation. */
  tags?: string[];
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  expirations: number;
  invalidations: number;
  flushes: number;
  size: number;
  maxSize: number;
}

export interface CacheOptions {
  /** Maximum number of entries. Defaults to 1000. */
  maxSize?: number;
  /** Default TTL in milliseconds. Defaults to 30_000. */
  defaultTtlMs?: number;
  /** Clock function (for tests). Defaults to Date.now. */
  now?: () => number;
}

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
  tags: Set<string>;
}

export type InvalidationListener = (event: {
  type: 'tag' | 'flush';
  tag?: string;
}) => void;

export class LruCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly tagIndex = new Map<string, Set<string>>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<InvalidationListener>();

  private hits = 0;
  private misses = 0;
  private sets = 0;
  private evictions = 0;
  private expirations = 0;
  private invalidations = 0;
  private flushes = 0;

  constructor(options: CacheOptions = {}) {
    this.maxSize = Math.max(1, options.maxSize ?? 1000);
    this.defaultTtlMs = Math.max(0, options.defaultTtlMs ?? 30_000);
    this.now = options.now ?? Date.now;
  }

  get<T = unknown>(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.deleteEntry(key);
      this.expirations++;
      this.misses++;
      return undefined;
    }
    // Refresh LRU ordering.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value as T;
  }

  has(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.deleteEntry(key);
      this.expirations++;
      return false;
    }
    return true;
  }

  set<T = unknown>(key: string, value: T, options: CacheEntryOptions = {}): void {
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const tags = new Set(options.tags ?? []);

    // Remove any existing entry first so tag index stays consistent.
    if (this.map.has(key)) {
      this.deleteEntry(key);
    }

    const entry: CacheEntry<T> = {
      value,
      expiresAt: this.now() + ttlMs,
      tags,
    };

    this.map.set(key, entry);
    for (const tag of tags) {
      let keys = this.tagIndex.get(tag);
      if (!keys) {
        keys = new Set();
        this.tagIndex.set(tag, keys);
      }
      keys.add(key);
    }
    this.sets++;

    // Evict oldest entries (Map preserves insertion order).
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.deleteEntry(oldestKey);
      this.evictions++;
    }
  }

  delete(key: string): boolean {
    return this.deleteEntry(key);
  }

  /** Invalidate all entries associated with the given tag. */
  invalidateTag(tag: string): number {
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) {
      this.tagIndex.delete(tag);
      return 0;
    }
    let removed = 0;
    for (const key of Array.from(keys)) {
      if (this.deleteEntry(key)) removed++;
    }
    this.tagIndex.delete(tag);
    this.invalidations += removed;
    this.emit({ type: 'tag', tag });
    return removed;
  }

  /** Remove all entries. */
  flush(): void {
    this.map.clear();
    this.tagIndex.clear();
    this.flushes++;
    this.emit({ type: 'flush' });
  }

  /** Register a listener invoked on tag invalidation and flush. */
  onInvalidate(listener: InvalidationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      evictions: this.evictions,
      expirations: this.expirations,
      invalidations: this.invalidations,
      flushes: this.flushes,
      size: this.map.size,
      maxSize: this.maxSize,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.evictions = 0;
    this.expirations = 0;
    this.invalidations = 0;
    this.flushes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  private deleteEntry(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    for (const tag of entry.tags) {
      const keys = this.tagIndex.get(tag);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) this.tagIndex.delete(tag);
      }
    }
    return true;
  }

  private emit(event: { type: 'tag' | 'flush'; tag?: string }): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listeners must not break cache operations.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instance + helpers
// ---------------------------------------------------------------------------

export const cache = new LruCache({
  maxSize: Number(process.env.CACHE_MAX_SIZE ?? 1000),
  defaultTtlMs: Number(process.env.CACHE_DEFAULT_TTL_MS ?? 30_000),
});

export function get<T = unknown>(key: string): T | undefined {
  return cache.get<T>(key);
}

export function set<T = unknown>(
  key: string,
  value: T,
  options?: CacheEntryOptions,
): void {
  cache.set(key, value, options);
}

export function invalidateTag(tag: string): number {
  return cache.invalidateTag(tag);
}

export function flush(): void {
  cache.flush();
}

export function stats(): CacheStats {
  return cache.stats();
}

export function onInvalidate(listener: InvalidationListener): () => void {
  return cache.onInvalidate(listener);
}

/**
 * Convenience wrapper: return cached value or compute, store and return it.
 */
export async function getOrSet<T>(
  key: string,
  factory: () => Promise<T> | T,
  options?: CacheEntryOptions,
): Promise<T> {
  const cached = cache.get<T>(key);
  if (cached !== undefined) return cached;
  const value = await factory();
  cache.set(key, value, options);
  return value;
}

// ---------------------------------------------------------------------------
// Well-known cache tags used across the app.
// ---------------------------------------------------------------------------

export const CacheTags = {
  IndexerState: 'indexer_state',
  Templates: 'templates',
  Stats: 'stats',
} as const;

export type CacheTag = (typeof CacheTags)[keyof typeof CacheTags];