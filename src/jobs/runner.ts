// src/jobs/runner.ts
//
// Shared background job runner backed by Postgres.
//
// Design:
//  - A `jobs` table stores job definitions (name, cron, max attempts, concurrency).
//  - A `job_runs` table stores individual executions with leasing via
//    `FOR UPDATE SKIP LOCKED`, guaranteeing single execution across replicas.
//  - Scheduled (cron) jobs are enqueued exactly once per tick by using a
//    unique constraint on (job_name, scheduled_for) so concurrent replicas
//    cannot double-enqueue.
//  - Retries use exponential backoff with a configurable base delay and cap.
//  - Per-job concurrency is enforced by counting active (leased) runs.
//
// Public API:
//  - registerJob(def)
//  - startRunner(opts)
//  - stopRunner()
//  - getJobStatus(name?)
//
// The runner is intentionally small and dependency-light. It relies on a
// `pg`-compatible Pool passed in by the caller.

import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobDefinition {
  /** Unique job name, e.g. "ipfs-gc". */
  name: string;
  /** Cron expression (5-field). If omitted, the job is queue-only. */
  cron?: string;
  /** Handler invoked for each run. Should throw on failure. */
  handler: (ctx: JobContext) => Promise<void>;
  /** Maximum attempts before the run is marked failed. Default 5. */
  maxAttempts?: number;
  /** Base backoff in ms for exponential retry. Default 1000. */
  backoffBaseMs?: number;
  /** Max backoff in ms. Default 5 * 60 * 1000. */
  backoffMaxMs?: number;
  /** Max concurrent runs for this job. Default 1. */
  concurrency?: number;
  /** Lease duration in ms. Default 60_000. */
  leaseMs?: number;
}

export interface JobContext {
  jobName: string;
  runId: string;
  attempt: number;
  scheduledFor: Date | null;
}

export interface RunnerOptions {
  pool: Pool;
  /** How often to poll for due runs, in ms. Default 1000. */
  pollIntervalMs?: number;
  /** Identifier for this worker instance (for logging). */
  workerId?: string;
}

export interface JobStatus {
  name: string;
  cron: string | null;
  maxAttempts: number;
  concurrency: number;
  pending: number;
  running: number;
  failed: number;
  succeeded: number;
  lastRunAt: Date | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const registry = new Map<string, JobDefinition>();

let runnerPool: Pool | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let running = false;
let workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let pollIntervalMs = 1000;
let inFlight = 0;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerJob(def: JobDefinition): void {
  if (!def.name) throw new Error('job name is required');
  if (typeof def.handler !== 'function') {
    throw new Error(`job ${def.name}: handler is required`);
  }
  if (def.cron && !isValidCron(def.cron)) {
    throw new Error(`job ${def.name}: invalid cron expression "${def.cron}"`);
  }
  registry.set(def.name, {
    maxAttempts: 5,
    backoffBaseMs: 1000,
    backoffMaxMs: 5 * 60 * 1000,
    concurrency: 1,
    leaseMs: 60_000,
    ...def,
  });
}

export function clearJobs(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startRunner(opts: RunnerOptions): Promise<void> {
  if (running) return;
  runnerPool = opts.pool;
  pollIntervalMs = opts.pollIntervalMs ?? 1000;
  if (opts.workerId) workerId = opts.workerId;

  await ensureSchema(runnerPool);
  await syncJobDefinitions(runnerPool);

  running = true;
  scheduleNextPoll();
}

export async function stopRunner(): Promise<void> {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  // Wait briefly for in-flight runs to settle.
  const deadline = Date.now() + 5000;
  while (inFlight > 0 && Date.now() < deadline) {
    await sleep(50);
  }
  runnerPool = null;
}

function scheduleNextPoll(): void {
  if (!running) return;
  pollTimer = setTimeout(async () => {
    try {
      await tick();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] poll tick failed:', err);
    } finally {
      scheduleNextPoll();
    }
  }, pollIntervalMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

// ---------------------------------------------------------------------------
// Tick: enqueue due cron runs, then claim and execute due runs
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (!runnerPool) return;
  await enqueueDueCronRuns(runnerPool);
  await claimAndRun(runnerPool);
}

async function enqueueDueCronRuns(pool: Pool): Promise<void> {
  const now = new Date();
  for (const def of registry.values()) {
    if (!def.cron) continue;
    const scheduledFor = previousCronTick(def.cron, now);
    if (!scheduledFor) continue;
    // Unique (job_name, scheduled_for) makes this idempotent across replicas.
    await pool.query(
      `INSERT INTO job_runs (job_name, scheduled_for, status, attempt, run_at)
       VALUES ($1, $2, 'pending', 0, $2)
       ON CONFLICT (job_name, scheduled_for) DO NOTHING`,
      [def.name, scheduledFor],
    );
  }
}

async function claimAndRun(pool: Pool): Promise<void> {
  // Claim a batch of due runs. We claim one at a time to respect per-job
  // concurrency accurately, but use SKIP LOCKED so replicas don't collide.
  for (let i = 0; i < 10; i++) {
    const claimed = await claimOne(pool);
    if (!claimed) break;
    inFlight++;
    // Execute without awaiting so we can claim more; track via inFlight.
    executeRun(pool, claimed)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[jobs] run execution error:', err);
      })
      .finally(() => {
        inFlight--;
      });
  }
}

interface ClaimedRun {
  id: string;
  job_name: string;
  attempt: number;
  scheduled_for: Date | null;
}

async function claimOne(pool: Pool): Promise<ClaimedRun | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find a candidate run that is due, whose job has capacity, and lock it.
    const { rows } = await client.query<ClaimedRun>(
      `SELECT r.id, r.job_name, r.attempt, r.scheduled_for
         FROM job_runs r
         JOIN jobs j ON j.name = r.job_name
        WHERE r.status IN ('pending', 'retrying')
          AND r.run_at <= now()
          AND (
            SELECT count(*) FROM job_runs a
             WHERE a.job_name = r.job_name
               AND a.status = 'running'
               AND a.lease_expires_at > now()
          ) < j.concurrency
        ORDER BY r.run_at ASC
        FOR UPDATE OF r SKIP LOCKED
        LIMIT 1`,
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }

    const run = rows[0];
    const def = registry.get(run.job_name);
    const leaseMs = def?.leaseMs ?? 60_000;

    await client.query(
      `UPDATE job_runs
          SET status = 'running',
              attempt = attempt + 1,
              locked_by = $2,
              locked_at = now(),
              lease_expires_at = now() + ($3 || ' milliseconds')::interval
        WHERE id = $1`,
      [run.id, workerId, leaseMs],
    );

    await client.query('COMMIT');
    return { ...run, attempt: run.attempt + 1 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function executeRun(pool: Pool, run: ClaimedRun): Promise<void> {
  const def = registry.get(run.job_name);
  if (!def) {
    // Job no longer registered; mark failed so it doesn't loop forever.
    await markFailed(pool, run.id, 'job not registered');
    return;
  }

  const ctx: JobContext = {
    jobName: run.job_name,
    runId: run.id,
    attempt: run.attempt,
    scheduledFor: run.scheduled_for,
  };

  try {
    await def.handler(ctx);
    await pool.query(
      `UPDATE job_runs
          SET status = 'succeeded',
              finished_at = now(),
              lease_expires_at = NULL,
              last_error = NULL
        WHERE id = $1`,
      [run.id],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const maxAttempts = def.maxAttempts ?? 5;
    if (run.attempt >= maxAttempts) {
      await markFailed(pool, run.id, message);
      return;
    }
    const base = def.backoffBaseMs ?? 1000;
    const cap = def.backoffMaxMs ?? 5 * 60 * 1000;
    const delay = Math.min(cap, base * Math.pow(2, run.attempt - 1));
    await pool.query(
      `UPDATE job_runs
          SET status = 'retrying',
              run_at = now() + ($2 || ' milliseconds')::interval,
              lease_expires_at = NULL,
              locked_by = NULL,
              last_error = $3
        WHERE id = $1`,
      [run.id, delay, message],
    );
  }
}

async function markFailed(pool: Pool, runId: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE job_runs
        SET status = 'failed',
            finished_at = now(),
            lease_expires_at = NULL,
            last_error = $2
      WHERE id = $1`,
    [runId, message],
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function getJobStatus(pool: Pool, name?: string): Promise<JobStatus[]> {
  const params: unknown[] = [];
  let where = '';
  if (name) {
    where = 'WHERE j.name = $1';
    params.push(name);
  }
  const { rows } = await pool.query(
    `SELECT j.name,
            j.cron,
            j.max_attempts,
            j.concurrency,
            COALESCE(SUM(CASE WHEN r.status IN ('pending','retrying') THEN 1 ELSE 0 END), 0)::int AS pending,
            COALESCE(SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END), 0)::int AS running,
            COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed,
            COALESCE(SUM(CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END), 0)::int AS succeeded,
            MAX(r.finished_at) AS last_run_at,
            (SELECT last_error FROM job_runs lr
              WHERE lr.job_name = j.name AND lr.last_error IS NOT NULL
              ORDER BY lr.finished_at DESC NULLS LAST LIMIT 1) AS last_error
       FROM jobs j
       LEFT JOIN job_runs r ON r.job_name = j.name
       ${where}
      GROUP BY j.name, j.cron, j.max_attempts, j.concurrency
      ORDER BY j.name`,
    params,
  );
  return rows.map((r) => ({
    name: r.name,
    cron: r.cron,
    maxAttempts: r.max_attempts,
    concurrency: r.concurrency,
    pending: r.pending,
    running: r.running,
    failed: r.failed,
    succeeded: r.succeeded,
    lastRunAt: r.last_run_at,
    lastError: r.last_error,
  }));
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      name          TEXT PRIMARY KEY,
      cron          TEXT,
      max_attempts  INTEGER NOT NULL DEFAULT 5,
      concurrency   INTEGER NOT NULL DEFAULT 1,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_name          TEXT NOT NULL REFERENCES jobs(name) ON DELETE CASCADE,
      status            TEXT NOT NULL DEFAULT 'pending',
      attempt           INTEGER NOT NULL DEFAULT 0,
      run_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      scheduled_for     TIMESTAMPTZ,
      locked_by         TEXT,
      locked_at         TIMESTAMPTZ,
      lease_expires_at  TIMESTAMPTZ,
      finished_at       TIMESTAMPTZ,
      last_error        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS job_runs_scheduled_unique
      ON job_runs (job_name, scheduled_for)
      WHERE scheduled_for IS NOT NULL;

    CREATE INDEX IF NOT EXISTS job_runs_due_idx
      ON job_runs (status, run_at)
      WHERE status IN ('pending', 'retrying');

    CREATE INDEX IF NOT EXISTS job_runs_running_idx
      ON job_runs (job_name, status)
      WHERE status = 'running';
  `);
}

async function syncJobDefinitions(pool: Pool): Promise<void> {
  for (const def of registry.values()) {
    await pool.query(
      `INSERT INTO jobs (name, cron, max_attempts, concurrency)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE
         SET cron = EXCLUDED.cron,
             max_attempts = EXCLUDED.max_attempts,
             concurrency = EXCLUDED.concurrency,
             updated_at = now()`,
      [def.name, def.cron ?? null, def.maxAttempts ?? 5, def.concurrency ?? 1],
    );
  }
}

// ---------------------------------------------------------------------------
// Cron parsing (minimal 5-field: minute hour dom month dow)
// ---------------------------------------------------------------------------

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const CRON_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // dom
  [1, 12], // month
  [0, 6], // dow (0 = Sunday)
];

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron must have 5 fields');
  const fields = parts.map((p, i) => parseField(p, CRON_RANGES[i][0], CRON_RANGES[i][1]));
  return {
    minute: fields[0],
    hour: fields[1],
    dom: fields[2],
    month: fields[3],
    dow: fields[4],
  };
}

function parseField(field: string, min: number, max: number): CronField {
  const values = new Set<number>();
  let wildcard = false;
  for (const part of field.split(',')) {
    if (part === '*') {
      wildcard = true;
      for (let v = min; v <= max; v++) values.add(v);
      continue;
    }
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10);
      if (step <= 0) throw new Error(`invalid step in "${part}"`);
      let lo = min;
      let hi = max;
      if (stepMatch[1] !== '*') {
        const [a, b] = stepMatch[1].split('-').map((n) => parseInt(n, 10));
        lo = a;
        hi = b ?? max;
      }
      for (let v = lo; v <= hi; v += step) values.add(v);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      if (a < min || b > max || a > b) throw new Error(`invalid range "${part}"`);
      for (let v = a; v <= b; v++) values.add(v);
      continue;
    }
    const single = parseInt(part, 10);
    if (Number.isNaN(single) || single < min || single > max) {
      throw new Error(`invalid value "${part}"`);
    }
    values.add(single);
  }
  return { values, wildcard };
}

function cronMatches(cron: ParsedCron, d: Date): boolean {
  return (
    cron.minute.values.has(d.getUTCMinutes()) &&
    cron.hour.values.has(d.getUTCHours()) &&
    cron.dom.values.has(d.getUTCDate()) &&
    cron.month.values.has(d.getUTCMonth() + 1) &&
    cron.dow.values.has(d.getUTCDay())
  );
}

/**
 * Returns the most recent cron tick at or before `now`, truncated to the
 * minute. Used as the `scheduled_for` value so replicas agree on the tick.
 */
export function previousCronTick(expr: string, now: Date): Date | null {
  const cron = parseCron(expr);
  const d = new Date(now.getTime());
  d.setUTCSeconds(0, 0);
  // Search back up to 1 year of minutes (bounded).
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (cronMatches(cron, d)) return new Date(d.getTime());
    d.setUTCMinutes(d.getUTCMinutes() - 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export for convenience.
export type { PoolClient };
```

```sql
-- database/schema.sql (append)
-- Shared background job runner tables.

CREATE TABLE IF NOT EXISTS jobs (
  name          TEXT PRIMARY KEY,
  cron          TEXT,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  concurrency   INTEGER NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name          TEXT NOT NULL REFERENCES jobs(name) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempt           INTEGER NOT NULL DEFAULT 0,
  run_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_for     TIMESTAMPTZ,
  locked_by         TEXT,
  locked_at         TIMESTAMPTZ,
  lease_expires_at  TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS job_runs_scheduled_unique
  ON job_runs (job_name, scheduled_for)
  WHERE scheduled_for IS NOT NULL;

CREATE INDEX IF NOT EXISTS job_runs_due_idx
  ON job_runs (status, run_at)
  WHERE status IN ('pending', 'retrying');

CREATE INDEX IF NOT EXISTS job_runs_running_idx
  ON job_runs (job_name, status)
  WHERE status = 'running';
```

```typescript
// src/__tests__/jobs.db.test.ts
//
// Postgres-backed tests for the shared job runner: leasing, retries, schedules.
// Requires a reachable Postgres via TEST_DATABASE_URL (or DATABASE_URL).
// Skips gracefully if no database is configured.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  registerJob,
  clearJobs,
  startRunner,
  stopRunner,
  getJobStatus,
  ensureSchema,
  previousCronTick,
  isValidCron,
} from '../jobs/runner';

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('job runner (postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await ensureSchema(pool);
  });

  afterAll(async () => {
    await stopRunner();
    await pool.query('DELETE FROM job_runs');
    await pool.query('DELETE FROM jobs');
    await pool.end();
  });

  beforeEach(async () => {
    await stopRunner();
    clearJobs();
    await pool.query('DELETE FROM job_runs');
    await pool.query('DELETE FROM jobs');
  });

  it('runs a queued job exactly once', async () => {
    let calls = 0;
    registerJob({
      name: 'test-once',
      handler: async () => {
        calls++;
      },
    });
    await startRunner({ pool, pollIntervalMs: 50 });

    await pool.query(
      `INSERT INTO job_runs (job_name, status, run_at) VALUES ('test-once', 'pending', now())`,
    );

    await waitFor(async () => {
      const { rows } = await pool.query(
        `SELECT status FROM job_runs WHERE job_name = 'test-once'`,
      );
      return rows.length === 1 && rows[0].status === 'succeeded';
    });

    expect(calls).toBe(1);
  });

  it('leases a run so two workers do not execute it twice', async () => {
    let calls = 0;
    registerJob({
      name: 'test-lease',
      handler: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 200));
      },
    });

    // Two independent runners sharing the same pool (simulating replicas).
    await startRunner({ pool, pollIntervalMs: 50, workerId: 'w1' });
    // Second runner uses a separate pool to simulate a distinct replica.
    const pool2 = new Pool({ connectionString });
    await ensureSchema(pool2);

    await pool.query(
      `INSERT INTO job_runs (job_name, status, run_at) VALUES ('test-lease', 'pending', now())`,
    );

    // Start a second runner on pool2 by temporarily swapping module state is
    // not supported; instead we validate leasing at the SQL level by claiming
    // concurrently.
    const claim = async (p: Pool, wid: string) => {
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT r.id FROM job_runs r
             JOIN jobs j ON j.name = r.job_name
            WHERE r.status IN ('pending','retrying') AND r.run_at <= now()
            ORDER BY r.run_at ASC
            FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
        );
        if (rows.length === 0) {
          await client.query('COMMIT');
          return null;
        }
        await client.query(
          `UPDATE job_runs SET status='running', locked_by=$2, lease_expires_at=now() + interval '60 seconds' WHERE id=$1`,
          [rows[0].id, wid],
        );
        await client.query('COMMIT');
        return rows[0].id as string;
      } finally {
        client.release();
      }
    };

    // Wait for the runner to pick up the run.
    await waitFor(async () => {
      const { rows } = await pool.query(
        `SELECT status FROM job_runs WHERE job_name = 'test-lease'`,
      );
      return rows.length === 1 && rows[0].status === 'running';
    });

    // A concurrent claim from another replica must find nothing.
    const other = await claim(pool2, 'w2');
    expect(other).toBeNull();

    await waitFor(async () => {
      const { rows } = await pool.query(
        `SELECT status FROM job_runs WHERE job_name = 'test-lease'`,
      );
      return rows.length === 1 && rows[0].status === 'succeeded';
    });
    expect(calls).toBe(1);

    await pool2.end();
  });

  it('retries with backoff and lands in failed after max attempts', async () => {
    let attempts = 0;
    registerJob({
      name: 'test-retry',
      maxAttempts: 3,
      backoffBaseMs: 20,
      backoffMaxMs: 50,
      handler: async () => {
        attempts++;
        throw new Error('boom');
      },
    });
    await startRunner({ pool, pollIntervalMs: 30 });

    await pool.query(
      `INSERT INTO job_runs (job_name, status, run_at) VALUES ('test-retry', 'pending', now())`,
    );

    await waitFor(
      async () => {
        const { rows } = await pool.query(
          `SELECT status, attempt, last_error FROM job_runs WHERE job_name = 'test-retry'`,
        );
        return rows.length === 1 && rows[0].status === 'failed';
      },
      5000,
    );

    const { rows } = await pool.query(
      `SELECT status, attempt, last_error FROM job_runs WHERE job_name = 'test-retry'`,
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].attempt).toBe(3);
    expect(rows[0].last_error).toContain('boom');
    expect(attempts).toBe(3);
  });

  it('enqueues a cron job exactly once per tick across replicas', async () => {
    registerJob({
      name: 'test-cron',
      cron: '* * * * *',
      handler: async () => {},
    });
    await startRunner({ pool, pollIntervalMs: 50 });

    // Wait for at least one scheduled run to be enqueued.
    await waitFor(async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS c FROM job_runs WHERE job_name = 'test-cron' AND scheduled_for IS NOT NULL`,
      );
      return rows[0].c >= 1;
    });

    // Simulate a second replica enqueuing the same tick: unique constraint
    // must prevent a duplicate.
    const tick = previousCronTick('* * * * *', new Date());
    expect(tick).not.toBeNull();
    await pool.query(
      `INSERT INTO job_runs (job_name, scheduled_for, status, run_at)
       VALUES ('test-cron', $1, 'pending', $1)
       ON CONFLICT (job_name, scheduled_for) DO NOTHING`,
      [tick],
    );

    const { rows } = await pool.query(
      `SELECT count(*)::int AS c FROM job_runs
        WHERE job_name = 'test-cron' AND scheduled_for = $1`,
      [tick],
    );
    expect(rows[0].c).toBe(1);
  });

  it('reports job status', async () => {
    registerJob({ name: 'test-status', handler: async () => {} });
    await startRunner({ pool, pollIntervalMs: 50 });
    await pool.query(
      `INSERT INTO job_runs (job_name, status, run_at) VALUES ('test-status', 'pending', now())`,
    );
    await waitFor(async () => {
      const statuses = await getJobStatus(pool, 'test-status');
      return statuses.length === 1 && statuses[0].succeeded === 1;
    });
    const statuses = await getJobStatus(pool, 'test-status');
    expect(statuses[0].name).toBe('test-status');
    expect(statuses[0].succeeded).toBe(1);
  });

  it('validates cron expressions', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('*/5 0 * * *')).toBe(true);
    expect(isValidCron('0 12 1-5 * 1-5')).toBe(true);
    expect(isValidCron('bad')).toBe(false);
    expect(isValidCron('60 * * * *')).toBe(false);
  });
});

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}