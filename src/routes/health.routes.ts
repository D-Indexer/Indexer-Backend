import { Router } from 'express';
import pool from '../db/client';
import { asyncHandler } from '../middleware/asyncHandler';
import { getEnv } from '../config/env';

const router = Router();
const env = getEnv();

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Healthcheck timed out')), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout!);
  }
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    let dbOk = false;
    try {
      await withTimeout(pool.query('SELECT 1'), env.HEALTHCHECK_DATABASE_TIMEOUT_MS);
      dbOk = true;
    } catch {
      dbOk = false;
    }

    let indexerCursor: string | null = null;
    try {
      const { rows } = await pool.query(
        "SELECT value FROM indexer_state WHERE key = 'indexer_cursor'"
      );
      indexerCursor = rows[0]?.value ?? null;
    } catch {
      // db already failed
    }

    const status = dbOk ? 'ok' : 'degraded';
    res.status(dbOk ? 200 : 503).json({
      status,
      db: dbOk ? 'ok' : 'unreachable',
      indexer: { cursor: indexerCursor },
      requestId: _req.id,
    });
  })
);

export default router;
