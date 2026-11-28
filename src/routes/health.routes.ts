import { Router } from 'express';
import pool from '../db/client';
import { getEnv } from '../config/env';
import { readState, STATE } from '../indexer/stellar';
import { getCacheStats } from '../cache';

export interface HealthRoutesDeps {
  db: Pool;
  env: Pick<Env, 'HEALTHCHECK_DATABASE_TIMEOUT_MS' | 'INDEXER_STALE_AFTER_MS'>;
  readState: (db: Pool) => Promise<Partial<Record<string, string>>>;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Healthcheck timed out')), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJson(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * API health: 200 when the database answers. Indexer state is reported for
 * visibility but doesn't affect the status code; the indexer process has its
 * own healthcheck (`npm run indexer -- healthcheck`).
 */
router.get('/', async (req, res) => {
  let dbOk = false;
  let state: Partial<Record<string, string>> = {};
  try {
    state = await withTimeout(readState(pool), env.HEALTHCHECK_DATABASE_TIMEOUT_MS);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const lastSuccessAt = state[STATE.lastSuccessAt] ?? null;
  const lastSuccessMs = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
  const stale = !Number.isFinite(lastSuccessMs) || Date.now() - lastSuccessMs > env.INDEXER_STALE_AFTER_MS;

  const lastLedger = state[STATE.lastLedger];

  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'unreachable',
    indexer: {
      status: state[STATE.status] ?? 'not_started',
      stale,
      lastLedger: lastLedger !== undefined ? Number(lastLedger) : null,
      lastSuccessAt,
      lastError: state[STATE.lastError] ?? null,
    },
    requestId: req.id,
  });
});

export default router;
