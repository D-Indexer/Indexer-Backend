import { createHmac, randomBytes } from 'crypto';
import type { Queryable } from '../db/types';

/**
 * API keys for third-party integrators.
 *
 * Keys look like `fk_<43 base64url chars>` (32 random bytes). Only an
 * HMAC-SHA256 of the key under a server secret (API_KEY_HMAC_SECRET) is
 * stored: fast enough to verify on every request, and, unlike a plain hash,
 * useless to an attacker who obtains the table without the secret. The
 * plaintext key is returned once, at creation, and never stored or logged.
 */

const KEY_PREFIX = 'fk_';
const KEY_PATTERN = /^fk_[A-Za-z0-9_-]{43}$/;

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}

export function isWellFormedApiKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function hashApiKey(secret: string, key: string): string {
  return createHmac('sha256', secret).update(key, 'utf8').digest('hex');
}

export interface ApiKeyRecord {
  id: number;
  name: string;
  contact: string;
  createdAt: Date;
  revokedAt: Date | null;
  /** Requests allowed per calendar month (UTC); null means no quota. */
  monthlyQuota: number | null;
}

export interface ApiKeyListing extends ApiKeyRecord {
  requestsThisMonth: number;
}

type ApiKeyRow = {
  id: string;
  name: string;
  contact: string;
  created_at: Date;
  revoked_at: Date | null;
  monthly_quota: string | null;
};

function mapKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: Number(row.id),
    name: row.name,
    contact: row.contact,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    monthlyQuota: row.monthly_quota === null ? null : Number(row.monthly_quota),
  };
}

const KEY_COLUMNS = 'id, name, contact, created_at, revoked_at, monthly_quota';

/** First day (UTC) of the month containing `at`, as YYYY-MM-DD. */
export function monthStart(at: Date): string {
  return `${at.toISOString().slice(0, 7)}-01`;
}

/** First instant of the next UTC month: when a monthly quota resets. */
export function nextMonthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

export interface CreateApiKeyInput {
  name: string;
  contact: string;
  monthlyQuota: number | null;
}

/** Create a key. The returned plaintext `key` is the only copy that will ever exist. */
export async function createApiKey(
  db: Queryable,
  secret: string,
  input: CreateApiKeyInput
): Promise<{ record: ApiKeyRecord; key: string }> {
  const key = generateApiKey();
  const { rows } = await db.query<ApiKeyRow>(
    `INSERT INTO api_keys (key_hash, name, contact, monthly_quota) VALUES ($1, $2, $3, $4)
     RETURNING ${KEY_COLUMNS}`,
    [hashApiKey(secret, key), input.name, input.contact, input.monthlyQuota]
  );
  const row = rows[0];
  if (!row) throw new Error('INSERT INTO api_keys returned no row');
  return { record: mapKey(row), key };
}

/** Revoke a key. Returns null if no such key; revoking twice keeps the first revocation time. */
export async function revokeApiKey(db: Queryable, id: number): Promise<ApiKeyRecord | null> {
  const { rows } = await db.query<ApiKeyRow>(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1 RETURNING ${KEY_COLUMNS}`,
    [id]
  );
  const row = rows[0];
  return row ? mapKey(row) : null;
}

export async function listApiKeys(db: Queryable, now: Date = new Date()): Promise<ApiKeyListing[]> {
  const { rows } = await db.query<ApiKeyRow & { requests_this_month: string }>(
    `SELECT ${KEY_COLUMNS.split(', ')
      .map((c) => `k.${c}`)
      .join(', ')},
            COALESCE((SELECT SUM(u.requests) FROM api_key_usage u
                       WHERE u.key_id = k.id AND u.day >= $1::date), 0) AS requests_this_month
       FROM api_keys k ORDER BY k.id`,
    [monthStart(now)]
  );
  return rows.map((row) => ({ ...mapKey(row), requestsThisMonth: Number(row.requests_this_month) }));
}

/** Look up a key by its hash, with its flushed usage for the month starting `month`. */
export async function findApiKeyByHash(
  db: Queryable,
  keyHash: string,
  month: string
): Promise<(ApiKeyRecord & { monthRequests: number }) | null> {
  const { rows } = await db.query<ApiKeyRow & { month_requests: string }>(
    `SELECT ${KEY_COLUMNS.split(', ')
      .map((c) => `k.${c}`)
      .join(', ')},
            COALESCE((SELECT SUM(u.requests) FROM api_key_usage u
                       WHERE u.key_id = k.id AND u.day >= $2::date), 0) AS month_requests
       FROM api_keys k WHERE k.key_hash = $1`,
    [keyHash, month]
  );
  const row = rows[0];
  return row ? { ...mapKey(row), monthRequests: Number(row.month_requests) } : null;
}

// ---------------------------------------------------------------------------
// Usage counting
// ---------------------------------------------------------------------------

/**
 * Write-optimised usage counter: requests are aggregated in memory per
 * (key, UTC day) and flushed as one multi-row upsert, so request handling
 * never waits on a database write. A failed flush puts its counts back to be
 * retried on the next flush. Counts not yet flushed when the process dies are
 * lost (at most one flush interval's worth).
 */
export class UsageRecorder {
  private counts = new Map<string, number>();
  private inFlight: Promise<number> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: Queryable) {}

  record(keyId: number, day: string, n = 1): void {
    const k = `${keyId}|${day}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + n);
  }

  /** Unflushed requests for `keyId` on or after `sinceDay` (YYYY-MM-DD). */
  pending(keyId: number, sinceDay: string): number {
    let total = 0;
    for (const [k, n] of this.counts) {
      const [id, day] = k.split('|');
      if (Number(id) === keyId && day !== undefined && day >= sinceDay) total += n;
    }
    return total;
  }

  /** Flush aggregated counts; returns the number of (key, day) rows written. Concurrent calls share one flush. */
  flush(): Promise<number> {
    if (!this.inFlight) {
      this.inFlight = this.doFlush().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doFlush(): Promise<number> {
    if (this.counts.size === 0) return 0;
    const batch = this.counts;
    this.counts = new Map();

    const ids: number[] = [];
    const days: string[] = [];
    const requests: number[] = [];
    for (const [k, n] of batch) {
      const [id, day] = k.split('|');
      ids.push(Number(id));
      days.push(day as string);
      requests.push(n);
    }

    try {
      await this.db.query(
        `INSERT INTO api_key_usage (key_id, day, requests)
         SELECT * FROM unnest($1::bigint[], $2::date[], $3::bigint[])
         ON CONFLICT (key_id, day) DO UPDATE SET requests = api_key_usage.requests + EXCLUDED.requests`,
        [ids, days, requests]
      );
      return batch.size;
    } catch (err) {
      for (const [k, n] of batch) this.counts.set(k, (this.counts.get(k) ?? 0) + n);
      throw err;
    }
  }

  /** Flush every `intervalMs` in the background; `onError` receives failed flushes (they are retried). */
  start(intervalMs: number, onError: (err: unknown) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(onError);
    }, intervalMs);
    this.timer.unref();
  }

  /** Stop the background flush and write out whatever is pending. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
