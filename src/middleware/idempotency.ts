import { createHash } from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import pool from '../db/client';
import { logger } from '../utils/logger';

/** Max key length mirrors x-request-id constraints. */
const VALID_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

type StoredResponse = {
  status: number;
  body: unknown;
};

type IdempotencyRow = {
  idempotency_key: string;
  fingerprint: string;
  status_code: number;
  response_body: unknown;
  in_progress: boolean;
  created_at: Date;
};

function fingerprintBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Idempotency middleware for multipart/file upload endpoints.
 * - Same key + same file fingerprint → replay stored response (no IPFS call).
 * - Same key + different fingerprint → 422 Unprocessable Entity.
 * - Concurrent duplicate key → 409 Conflict until first completes.
 * - Keys expire after TTL_HOURS (default 24 h).
 */
export function idempotency(ttlHours = 24): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const keyHeader = req.header('idempotency-key')?.trim();

    // No key provided — pass through normally
    if (!keyHeader) return next();

    if (!VALID_IDEMPOTENCY_KEY.test(keyHeader)) {
      res.status(400).json({ error: 'Invalid Idempotency-Key format', requestId: req.id });
      return;
    }

    // Fingerprint is computed from the raw file buffer (available after multer runs)
    const fileBuffer: Buffer | undefined = req.file?.buffer;
    const fingerprint = fileBuffer ? fingerprintBuffer(fileBuffer) : '';

    try {
      // Try to look up an existing record
      const { rows } = await pool.query<IdempotencyRow>(
        `SELECT idempotency_key, fingerprint, status_code, response_body, in_progress, created_at
           FROM idempotency_keys
          WHERE idempotency_key = $1
            AND created_at > NOW() - ($2 || ' hours')::INTERVAL`,
        [keyHeader, ttlHours]
      );

      if (rows.length > 0) {
        const row = rows[0];

        // Concurrent duplicate: first request still in progress
        if (row.in_progress) {
          res.status(409).json({
            error: 'A request with this Idempotency-Key is already in progress',
            requestId: req.id,
          });
          return;
        }

        // Fingerprint mismatch: different payload with same key
        if (row.fingerprint !== fingerprint) {
          res.status(422).json({
            error: 'Idempotency-Key reused with a different request payload',
            requestId: req.id,
          });
          return;
        }

        // Replay the stored response
        const stored = row.response_body as StoredResponse;
        res.status(row.status_code).json(stored);
        return;
      }

      // Insert a new in-progress record (fingerprint placeholder until response)
      await pool.query(
        `INSERT INTO idempotency_keys (idempotency_key, fingerprint, status_code, response_body, in_progress, created_at)
         VALUES ($1, $2, 0, 'null'::jsonb, true, NOW())
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [keyHeader, fingerprint]
      );

      // Intercept res.json to capture and persist the response
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        const statusCode = res.statusCode;
        // Persist asynchronously; don't block the response
        pool
          .query(
            `UPDATE idempotency_keys
                SET status_code = $1, response_body = $2::jsonb, in_progress = false
              WHERE idempotency_key = $3`,
            [statusCode, JSON.stringify(body), keyHeader]
          )
          .catch((err) => logger.error('Failed to persist idempotency response', { err, key: keyHeader }));
        return originalJson(body);
      };

      next();
    } catch (err) {
      logger.error('Idempotency middleware error', { err, key: keyHeader });
      next(err);
    }
  };
}
