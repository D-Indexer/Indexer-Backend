import type { Request, Response, NextFunction } from 'express';

/**
 * Feature flag service for runtime incident response.
 *
 * Flags are stored in the `feature_flags` table and read with a short TTL cache.
 * When a Postgres client that supports LISTEN/NOTIFY is provided, flag changes
 * are broadcast on the `feature_flags_changed` channel and caches are invalidated
 * immediately across replicas.
 */

export interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  updated_by: string | null;
  updated_at: Date | string;
  note: string | null;
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: Date;
  note: string | null;
}

export interface SetFlagOptions {
  updatedBy?: string | null;
  note?: string | null;
}

/**
 * Minimal database interface required by the service. This keeps the service
 * unit-testable without a real Postgres connection.
 */
export interface FeatureFlagDb {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}

/**
 * Minimal LISTEN/NOTIFY capable client interface. A `pg` client satisfies this.
 */
export interface FeatureFlagListener {
  query(sql: string, params?: any[]): Promise<unknown>;
  on(event: 'notification', listener: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export const FEATURE_FLAGS_CHANNEL = 'feature_flags_changed';

export interface FeatureFlagServiceOptions {
  db: FeatureFlagDb;
  /** Cache TTL in milliseconds. Defaults to 5000ms. */
  ttlMs?: number;
  /**
   * Optional LISTEN/NOTIFY client for cross-replica invalidation. Must be a
   * dedicated `pg.Client` on DATABASE_DIRECT_URL (`getDirectDatabaseUrl`), not
   * a pooled client: LISTEN does not survive PgBouncer transaction pooling.
   */
  listener?: FeatureFlagListener;
  /** Optional clock injection for tests. */
  now?: () => number;
}

export interface FeatureFlagService {
  isEnabled(key: string): Promise<boolean>;
  list(): Promise<FeatureFlag[]>;
  set(key: string, enabled: boolean, options?: SetFlagOptions): Promise<FeatureFlag>;
  /** Invalidate the local cache (all keys or a single key). */
  invalidate(key?: string): void;
  /** Stop listening for notifications and clear the cache. */
  close(): Promise<void>;
}

const DEFAULT_TTL_MS = 5000;

/**
 * Convert a raw database row into a normalized FeatureFlag object.
 */
export function normalizeFlagRow(row: FeatureFlagRow): FeatureFlag {
  return {
    key: row.key,
    enabled: Boolean(row.enabled),
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    note: row.note ?? null,
  };
}

/**
 * Evaluate whether a feature is enabled given a map of flags.
 * Unknown flags default to enabled so that a missing row never accidentally
 * disables a feature that has not been registered yet.
 */
export function evaluateFlag(flags: Map<string, FeatureFlag>, key: string): boolean {
  const flag = flags.get(key);
  if (!flag) {
    return true;
  }
  return flag.enabled;
}

interface CacheEntry {
  flags: Map<string, FeatureFlag>;
  expiresAt: number;
}

/**
 * Create a TTL cache for feature flags. Exported for unit testing.
 */
export function createFlagCache(ttlMs: number, now: () => number = Date.now) {
  let entry: CacheEntry | null = null;

  return {
    get(): Map<string, FeatureFlag> | null {
      if (!entry) {
        return null;
      }
      if (now() >= entry.expiresAt) {
        entry = null;
        return null;
      }
      return entry.flags;
    },
    set(flags: Map<string, FeatureFlag>): void {
      entry = { flags, expiresAt: now() + ttlMs };
    },
    invalidate(): void {
      entry = null;
    },
    isFresh(): boolean {
      return entry !== null && now() < entry.expiresAt;
    },
  };
}

export function createFeatureFlagService(options: FeatureFlagServiceOptions): FeatureFlagService {
  const { db, listener } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = createFlagCache(ttlMs, now);

  async function loadFlags(): Promise<Map<string, FeatureFlag>> {
    const cached = cache.get();
    if (cached) {
      return cached;
    }
    const result = await db.query<FeatureFlagRow>(
      'SELECT key, enabled, updated_by, updated_at, note FROM feature_flags',
    );
    const flags = new Map<string, FeatureFlag>();
    for (const row of result.rows) {
      const flag = normalizeFlagRow(row);
      flags.set(flag.key, flag);
    }
    cache.set(flags);
    return flags;
  }

  if (listener) {
    listener.on('notification', (msg) => {
      if (msg.channel === FEATURE_FLAGS_CHANNEL) {
        cache.invalidate();
      }
    });
    listener.on('error', () => {
      // On listener errors, drop the cache so the next read refetches.
      cache.invalidate();
    });
    // Fire-and-forget LISTEN; ignore failures so the service still works
    // with TTL-only invalidation.
    void Promise.resolve(listener.query(`LISTEN ${FEATURE_FLAGS_CHANNEL}`)).catch(() => {
      /* ignore */
    });
  }

  return {
    async isEnabled(key: string): Promise<boolean> {
      const flags = await loadFlags();
      return evaluateFlag(flags, key);
    },

    async list(): Promise<FeatureFlag[]> {
      const flags = await loadFlags();
      return Array.from(flags.values()).sort((a, b) => a.key.localeCompare(b.key));
    },

    async set(key: string, enabled: boolean, setOptions: SetFlagOptions = {}): Promise<FeatureFlag> {
      const updatedBy = setOptions.updatedBy ?? null;
      const note = setOptions.note ?? null;
      const result = await db.query<FeatureFlagRow>(
        `INSERT INTO feature_flags (key, enabled, updated_by, updated_at, note)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (key) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               updated_by = EXCLUDED.updated_by,
               updated_at = NOW(),
               note = EXCLUDED.note
         RETURNING key, enabled, updated_by, updated_at, note`,
        [key, enabled, updatedBy, note],
      );
      const flag = normalizeFlagRow(result.rows[0]);
      cache.invalidate();
      if (listener) {
        void Promise.resolve(
          listener.query('SELECT pg_notify($1, $2)', [FEATURE_FLAGS_CHANNEL, key]),
        ).catch(() => {
          /* ignore */
        });
      }
      return flag;
    },

    invalidate(key?: string): void {
      // The cache stores the full flag set; any change invalidates it wholesale.
      void key;
      cache.invalidate();
    },

    async close(): Promise<void> {
      cache.invalidate();
    },
  };
}

/**
 * Express middleware factory that gates a route behind a feature flag.
 * When the flag is disabled, responds with 503 and a clear message.
 */
export function requireFeatureFlag(
  service: Pick<FeatureFlagService, 'isEnabled'>,
  key: string,
  message?: string,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const enabled = await service.isEnabled(key);
      if (!enabled) {
        res.status(503).json({
          error: 'feature_disabled',
          feature: key,
          message: message ?? `The '${key}' feature is currently disabled. Please try again later.`,
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}