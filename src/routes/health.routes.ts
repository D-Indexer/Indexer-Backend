import { Router } from 'express';
import pool from '../db/client';
import { asyncHandler } from '../middleware/asyncHandler';
import { getEnv } from '../config/env';
import { readStaleness, readState, STATE } from '../indexer/stellar';
import { isShuttingDown } from '../shutdown';
import { checkKuboReachable } from '../services/ipfs';

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

type DependencyStatus = 'ok' | 'unreachable' | 'skipped';

interface DependencyCheck {
  status: DependencyStatus;
  latencyMs: number | null;
}

interface ReadinessChecks {
  db: DependencyCheck;
  ipfs: DependencyCheck;
}

let cachedChecks: { at: number; checks: ReadinessChecks } | null = null;

async function timed(check: () => Promise<unknown>): Promise<DependencyCheck> {
  const startedAt = performance.now();
  try {
    await check();
    return { status: 'ok', latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { status: 'unreachable', latencyMs: Math.round(performance.now() - startedAt) };
  }
}

/**
 * Run the readiness dependency checks, reusing a result for
 * HEALTHCHECK_CACHE_MS so frequent probes cannot storm the dependencies.
 */
async function runReadinessChecks(): Promise<ReadinessChecks> {
  const now = Date.now();
  if (cachedChecks && now - cachedChecks.at < env.HEALTHCHECK_CACHE_MS) {
    return cachedChecks.checks;
  }

  const [db, ipfs] = await Promise.all([
    timed(() => withTimeout(readState(pool), env.HEALTHCHECK_DATABASE_TIMEOUT_MS)),
    timed(() => checkKuboReachable(env.HEALTHCHECK_IPFS_TIMEOUT_MS)),
  ]);

  const checks: ReadinessChecks = { db, ipfs };
  cachedChecks = { at: Date.now(), checks };
  return checks;
}

/**
 * Liveness: the process is up and the event loop answers. No I/O, so a
 * database or Kubo blip never makes an orchestrator restart a healthy pod.
 */
router.get('/live', (req, res) => {
  res.status(200).json({ status: 'ok', requestId: req.id });
});

/**
 * Readiness: 200 only when the API can serve traffic — not shutting down, the
 * database answers within HEALTHCHECK_DATABASE_TIMEOUT_MS and the Kubo node
 * answers `/api/v0/version` within HEALTHCHECK_IPFS_TIMEOUT_MS.
 */
router.get(
  '/ready',
  asyncHandler(async (req, res) => {
    if (isShuttingDown()) {
      res.setHeader('Connection', 'close');
      res.status(503).json({
        status: 'shutting_down',
        dependencies: {
          db: { status: 'skipped', latencyMs: null },
          ipfs: { status: 'skipped', latencyMs: null },
        },
        requestId: req.id,
      });
      return;
    }

    const dependencies = await runReadinessChecks();
    const ready = dependencies.db.status === 'ok' && dependencies.ipfs.status === 'ok';

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      dependencies,
      requestId: req.id,
    });
  })
);

/**
 * API health: 200 when the database answers. Indexer state is reported for
 * visibility but doesn't affect the status code; the indexer process has its
 * own healthcheck (`npm run indexer -- healthcheck`).
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    if (isShuttingDown()) {
      res.setHeader('Connection', 'close');
      res.status(503).json({
        status: 'shutting_down',
        db: 'unknown',
        indexer: { status: 'unknown', stale: true, lagSeconds: null, lastLedger: null, lastSuccessAt: null, lastError: null },
        requestId: req.id,
      });
      return;
    }

    let dbOk = false;
    let state: Partial<Record<string, string>> = {};
    try {
      state = await withTimeout(readState(pool), env.HEALTHCHECK_DATABASE_TIMEOUT_MS);
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const lastSuccessAt = state[STATE.lastSuccessAt] ?? null;
    let lagSeconds: number | null = null;
    let stale = true;
    if (dbOk) {
      try {
        ({ lagSeconds, stale } = await withTimeout(
          readStaleness(pool, env.INDEXER_STALE_AFTER_MS),
          env.HEALTHCHECK_DATABASE_TIMEOUT_MS
        ));
      } catch {
        stale = true;
      }
    }

    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'unreachable',
      indexer: {
        status: state[STATE.status] ?? 'not_started',
        stale,
        lagSeconds,
        lastLedger: state[STATE.lastLedger] ? Number(state[STATE.lastLedger]) : null,
        lastSuccessAt,
        lastError: state[STATE.lastError] ?? null,
      },
      requestId: req.id,
    });
  })
);

export default router;
