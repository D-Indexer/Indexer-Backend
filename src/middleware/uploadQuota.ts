import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Minimal queryable interface so tests can inject a fake DB / clock.
 * Compatible with `pg.Pool` and `pg.PoolClient` (both expose `query`).
 */
export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

export interface UploadQuotaConfig {
  /** Salt used to hash client IPs. Raw IPs are never persisted. */
  ipHashSalt: string;
  /** Maximum bytes a client may upload per UTC day. `0` disables the check. */
  dailyByteQuota: number;
  /** Maximum number of files a client may upload per UTC day. `0` disables the check. */
  dailyFileQuota: number;
}

export interface UploadQuotaDeps {
  db: Queryable;
  config: UploadQuotaConfig;
  /** Injectable clock (defaults to `Date.now`). */
  clock?: () => number;
}

interface UploadQuotaRequest extends Request {
  clientHash?: string;
  uploadUsage?: { bytes: number; files: number };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compute the start of the current UTC day for the given timestamp.
 */
export function utcDayStart(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Compute the start of the next UTC day (the quota reset time).
 */
export function utcDayReset(now: number): Date {
  return new Date(utcDayStart(now).getTime() + MS_PER_DAY);
}

/**
 * Salted SHA-256 hash of a client IP. Raw IPs are never persisted.
 */
export function hashClientIp(ip: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

/**
 * SHA-256 of an uploaded buffer, used for the content blocklist.
 */
export function hashContent(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getUploadBuffer(req: Request): Buffer | undefined {
  const file = (req as any).file;
  if (file && Buffer.isBuffer(file.buffer)) {
    return file.buffer;
  }
  if (Buffer.isBuffer((req as any).body)) {
    return (req as any).body as Buffer;
  }
  return undefined;
}

/**
 * Factory for the upload quota middleware.
 *
 * Enforces:
 *  - SHA-256 content blocklist (rejected before reaching Kubo).
 *  - Per-client daily byte and file quotas (429 with reset time).
 *
 * Client identity is a salted hash of the IP (and wallet address once auth
 * exists); raw IPs are never persisted.
 */
export function createUploadQuotaMiddleware(deps: UploadQuotaDeps) {
  const { db, config } = deps;
  const clock = deps.clock ?? (() => Date.now());

  return async function uploadQuotaMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const now = clock();
      const dayStart = utcDayStart(now);
      const resetAt = utcDayReset(now);

      // 1. Content blocklist check (before anything reaches Kubo).
      const buffer = getUploadBuffer(req);
      if (buffer) {
        const contentHash = hashContent(buffer);
        const blockRes = await db.query(
          `SELECT 1 FROM content_blocklist WHERE content_hash = $1 LIMIT 1`,
          [contentHash],
        );
        if (blockRes.rows.length > 0) {
          res.status(403).json({
            error: 'content_blocked',
            message: 'This content is not permitted on this node.',
          });
          return;
        }
      }

      // 2. Per-client daily quota.
      const clientHash = hashClientIp(getClientIp(req), config.ipHashSalt);
      (req as UploadQuotaRequest).clientHash = clientHash;

      const usageRes = await db.query(
        `SELECT bytes_uploaded, file_count
           FROM upload_usage
          WHERE client_hash = $1 AND day = $2`,
        [clientHash, dayStart.toISOString()],
      );

      const currentBytes = usageRes.rows.length > 0 ? Number(usageRes.rows[0].bytes_uploaded) : 0;
      const currentFiles = usageRes.rows.length > 0 ? Number(usageRes.rows[0].file_count) : 0;

      const incomingBytes = buffer ? buffer.length : 0;
      const incomingFiles = 1;

      const byteExceeded =
        config.dailyByteQuota > 0 && currentBytes + incomingBytes > config.dailyByteQuota;
      const fileExceeded =
        config.dailyFileQuota > 0 && currentFiles + incomingFiles > config.dailyFileQuota;

      if (byteExceeded || fileExceeded) {
        const retryAfter = Math.max(0, Math.ceil((resetAt.getTime() - now) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          error: 'upload_quota_exceeded',
          message: 'Daily upload quota exceeded.',
          resetAt: resetAt.toISOString(),
          retryAfter,
          quota: {
            bytes: config.dailyByteQuota,
            files: config.dailyFileQuota,
          },
          usage: {
            bytes: currentBytes,
            files: currentFiles,
          },
        });
        return;
      }

      // 3. Record the usage for this upload.
      const updated = await db.query(
        `INSERT INTO upload_usage (client_hash, day, bytes_uploaded, file_count)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (client_hash, day)
         DO UPDATE SET
              bytes_uploaded = upload_usage.bytes_uploaded + EXCLUDED.bytes_uploaded,
              file_count = upload_usage.file_count + EXCLUDED.file_count
         RETURNING bytes_uploaded, file_count`,
        [clientHash, dayStart.toISOString(), incomingBytes, incomingFiles],
      );

      if (updated.rows.length > 0) {
        (req as UploadQuotaRequest).uploadUsage = {
          bytes: Number(updated.rows[0].bytes_uploaded),
          files: Number(updated.rows[0].file_count),
        };
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export default createUploadQuotaMiddleware;