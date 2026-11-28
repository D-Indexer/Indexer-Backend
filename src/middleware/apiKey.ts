import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Queryable } from '../db/types';
import { HttpError } from '../http/errors';
import {
  findApiKeyByHash,
  hashApiKey,
  isWellFormedApiKey,
  monthStart,
  nextMonthStart,
  UsageRecorder,
} from '../services/apiKeys';

/** How long a key lookup (including "unknown" and "revoked") is cached. Revocation takes effect within this. */
export const DEFAULT_API_KEY_CACHE_TTL_MS = 30_000;
/** How often aggregated usage is written to api_key_usage. */
export const DEFAULT_USAGE_FLUSH_INTERVAL_MS = 10_000;
/** Cap on cached lookups, so a flood of random keys can't grow memory without bound. */
const MAX_CACHE_ENTRIES = 10_000;

export interface ApiKeyAuthOptions {
  db: Queryable;
  /** HMAC secret keys are hashed with (API_KEY_HMAC_SECRET). */
  secret: string;
  cacheTtlMs?: number;
  flushIntervalMs?: number;
  /** Receives background flush failures (the counts are kept and retried). */
  onFlushError?: (err: unknown) => void;
  now?: () => Date;
}

/** What authenticated requests expose on `res.locals.apiKey`. Never the key itself. */
export interface AuthenticatedApiKey {
  id: number;
  name: string;
}

interface CacheEntry {
  expiresAt: number;
  month: string;
  key: {
    id: number;
    name: string;
    revoked: boolean;
    monthlyQuota: number | null;
  } | null;
  /** Requests this month as of the lookup: flushed rows plus this process's unflushed counts. */
  usedAtLoad: number;
  /** Requests accepted by this process since the lookup. */
  usedSinceLoad: number;
}

export interface ApiKeyAuth {
  middleware: RequestHandler;
  recorder: UsageRecorder;
  /** Stop background flushing and flush what's pending (call on shutdown). */
  stop(): Promise<void>;
}

const unauthorized = (message: string) => new HttpError(401, message);

/**
 * Optional API-key authentication for read endpoints.
 *
 * - No `Authorization` header: anonymous, passes through unchanged.
 * - `Authorization: Bearer <key>` with a valid, unrevoked key: the request is
 *   attributed to the key (`res.locals.apiKey`) and counted toward its usage.
 * - Malformed header or key, unknown key or revoked key: 401. A key that is
 *   sent but invalid is rejected rather than downgraded to anonymous, so an
 *   integrator finds out immediately that their key stopped working.
 * - Monthly quota exhausted: 429 with a Retry-After until the month resets.
 *
 * Lookups are cached for `cacheTtlMs`, so a revocation takes effect within
 * that window. Quota enforcement is per process and approximate across
 * replicas (each sees the others' usage once it has been flushed and the
 * cache entry refreshed).
 */
export function createApiKeyAuth(options: ApiKeyAuthOptions): ApiKeyAuth {
  const {
    db,
    secret,
    cacheTtlMs = DEFAULT_API_KEY_CACHE_TTL_MS,
    flushIntervalMs = DEFAULT_USAGE_FLUSH_INTERVAL_MS,
    onFlushError = () => undefined,
    now = () => new Date(),
  } = options;
  if (!secret) throw new Error('createApiKeyAuth requires a secret');

  const recorder = new UsageRecorder(db);
  const cache = new Map<string, CacheEntry>();
  const loading = new Map<string, Promise<CacheEntry>>();

  async function load(keyHash: string, at: Date): Promise<CacheEntry> {
    const month = monthStart(at);
    const found = await findApiKeyByHash(db, keyHash, month);
    const entry: CacheEntry = {
      expiresAt: at.getTime() + cacheTtlMs,
      month,
      key: found && {
        id: found.id,
        name: found.name,
        revoked: found.revokedAt !== null,
        monthlyQuota: found.monthlyQuota,
      },
      usedAtLoad: found ? found.monthRequests + recorder.pending(found.id, month) : 0,
      usedSinceLoad: 0,
    };
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(keyHash, entry);
    return entry;
  }

  async function lookup(keyHash: string, at: Date): Promise<CacheEntry> {
    const cached = cache.get(keyHash);
    if (cached && cached.expiresAt > at.getTime() && cached.month === monthStart(at)) return cached;
    // Concurrent requests with the same key share one database lookup.
    let pending = loading.get(keyHash);
    if (!pending) {
      pending = load(keyHash, at).finally(() => loading.delete(keyHash));
      loading.set(keyHash, pending);
    }
    return pending;
  }

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (header === undefined) {
      next();
      return;
    }

    const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
    if (!match) {
      next(unauthorized('Malformed Authorization header: expected "Bearer <API key>"'));
      return;
    }
    const key = match[1] as string;
    if (!isWellFormedApiKey(key)) {
      next(unauthorized('Malformed API key'));
      return;
    }

    const at = now();
    lookup(hashApiKey(secret, key), at)
      .then((entry) => {
        if (!entry.key) throw unauthorized('Invalid API key');
        if (entry.key.revoked) throw unauthorized('API key has been revoked');

        const quota = entry.key.monthlyQuota;
        if (quota !== null && entry.usedAtLoad + entry.usedSinceLoad >= quota) {
          const resetAt = nextMonthStart(at);
          res.setHeader('Retry-After', String(Math.ceil((resetAt.getTime() - at.getTime()) / 1000)));
          throw new HttpError(
            429,
            `Monthly quota of ${quota} requests exceeded for this API key; it resets at ${resetAt.toISOString()}`
          );
        }

        entry.usedSinceLoad += 1;
        recorder.record(entry.key.id, at.toISOString().slice(0, 10));
        const apiKey: AuthenticatedApiKey = { id: entry.key.id, name: entry.key.name };
        res.locals['apiKey'] = apiKey;
        next();
      })
      .catch(next);
  };

  recorder.start(flushIntervalMs, onFlushError);

  return { middleware, recorder, stop: () => recorder.stop() };
}
