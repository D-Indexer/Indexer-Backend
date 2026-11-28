// src/outbox/dispatcher.ts
//
// Transactional outbox dispatcher.
//
// The indexer writes one outbox row per (applied event, subscriber type) inside
// the same page transaction that applies the events. This dispatcher leases
// pending rows with `FOR UPDATE SKIP LOCKED` (so multiple dispatchers never
// deliver the same row concurrently), delivers them to registered sinks, and
// records retries with exponential backoff. Rows that exhaust their attempts are
// moved to the `dead` state (dead-letter).
//
// Delivery guarantee: at-least-once. Each row carries a stable idempotency key
// (`idempotency_key`) that is unique per (event, subscriber type). Sinks MUST
// treat redelivery of the same key as a no-op.

import type { Pool, PoolClient } from 'pg';

export interface OutboxRow {
  id: string;
  event_id: string;
  subscriber: string;
  payload: unknown;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  created_at: Date;
}

export interface Sink {
  name: string;
  deliver(row: OutboxRow): Promise<void>;
}

export interface DispatcherOptions {
  /** How many rows to lease per poll. Default 10. */
  batchSize?: number;
  /** How long a leased row is locked before another dispatcher may reclaim it. Default 30s. */
  leaseMs?: number;
  /** Poll interval when no rows are available. Default 1000ms. */
  pollIntervalMs?: number;
  /** Base delay for exponential backoff. Default 1000ms. */
  backoffBaseMs?: number;
  /** Maximum backoff delay. Default 5 minutes. */
  backoffMaxMs?: number;
  /** Default max attempts for rows that don't specify one. Default 5. */
  defaultMaxAttempts?: number;
  /** Optional logger. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface DispatcherHandle {
  /** Stop polling and wait for in-flight work to settle. */
  stop(): Promise<void>;
  /** Run a single poll cycle (useful for tests). Resolves with number of rows processed. */
  tick(): Promise<number>;
}

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

function computeBackoff(attempts: number, baseMs: number, maxMs: number): number {
  // attempts is the number of attempts already made (>=1 after a failure).
  const exp = Math.max(0, attempts - 1);
  const delay = baseMs * Math.pow(2, exp);
  return Math.min(delay, maxMs);
}

/**
 * Start the outbox dispatcher. Returns a handle that can be stopped.
 *
 * The dispatcher is safe to run in multiple processes concurrently: row leasing
 * uses `FOR UPDATE SKIP LOCKED` plus a `locked_until` lease so a crashed
 * dispatcher's rows become reclaimable after the lease expires.
 */
export function startDispatcher(
  pool: Pool,
  sinks: Sink[],
  options: DispatcherOptions = {},
): DispatcherHandle {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const defaultMaxAttempts = options.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logger = options.logger ?? console;

  const sinksByName = new Map<string, Sink>();
  for (const sink of sinks) {
    sinksByName.set(sink.name, sink);
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<number> | null = null;

  async function leaseRows(client: PoolClient): Promise<OutboxRow[]> {
    const result = await client.query<OutboxRow>(
      `SELECT id, event_id, subscriber, payload, idempotency_key,
              attempts, max_attempts, next_attempt_at, created_at
         FROM outbox
        WHERE state = 'pending'
          AND next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    return result.rows;
  }

  async function markLeased(client: PoolClient, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await client.query(
      `UPDATE outbox
          SET locked_until = now() + ($2::int * interval '1 millisecond'),
              locked_by = $3
        WHERE id = ANY($1::uuid[])`,
      [ids, leaseMs, `${process.pid}`],
    );
  }

  async function markDelivered(client: PoolClient, id: string): Promise<void> {
    await client.query(
      `UPDATE outbox
          SET state = 'delivered',
              delivered_at = now(),
              locked_until = NULL,
              locked_by = NULL,
              last_error = NULL
        WHERE id = $1`,
      [id],
    );
  }

  async function markFailed(
    client: PoolClient,
    row: OutboxRow,
    error: unknown,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const maxAttempts = row.max_attempts ?? defaultMaxAttempts;
    const message = error instanceof Error ? error.message : String(error);

    if (attempts >= maxAttempts) {
      await client.query(
        `UPDATE outbox
            SET state = 'dead',
                attempts = $2,
                last_error = $3,
                locked_until = NULL,
                locked_by = NULL,
                dead_at = now()
          WHERE id = $1`,
        [row.id, attempts, message],
      );
      logger.warn(
        `[outbox] row ${row.id} (${row.subscriber}) moved to dead after ${attempts} attempts: ${message}`,
      );
      return;
    }

    const delay = computeBackoff(attempts, backoffBaseMs, backoffMaxMs);
    await client.query(
      `UPDATE outbox
          SET attempts = $2,
              last_error = $3,
              next_attempt_at = now() + ($4::int * interval '1 millisecond'),
              locked_until = NULL,
              locked_by = NULL
        WHERE id = $1`,
      [row.id, attempts, message, delay],
    );
    logger.warn(
      `[outbox] row ${row.id} (${row.subscriber}) failed attempt ${attempts}/${maxAttempts}, retrying in ${delay}ms: ${message}`,
    );
  }

  async function deliverRow(row: OutboxRow): Promise<void> {
    const sink = sinksByName.get(row.subscriber);
    if (!sink) {
      // No sink registered for this subscriber type. Treat as a failure so it
      // eventually dead-letters rather than silently disappearing.
      throw new Error(`no sink registered for subscriber "${row.subscriber}"`);
    }
    await sink.deliver(row);
  }

  async function processRow(client: PoolClient, row: OutboxRow): Promise<void> {
    try {
      await deliverRow(row);
      await markDelivered(client, row.id);
    } catch (err) {
      await markFailed(client, row, err);
    }
  }

  async function tick(): Promise<number> {
    const client = await pool.connect();
    let rows: OutboxRow[] = [];
    try {
      await client.query('BEGIN');
      rows = await leaseRows(client);
      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }
      await markLeased(
        client,
        rows.map((r) => r.id),
      );
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      client.release();
      throw err;
    }

    // Deliver outside the leasing transaction so long-running sinks don't hold
    // row locks. The lease (locked_until) prevents concurrent delivery.
    for (const row of rows) {
      const deliveryClient = await pool.connect();
      try {
        await deliveryClient.query('BEGIN');
        await processRow(deliveryClient, row);
        await deliveryClient.query('COMMIT');
      } catch (err) {
        try {
          await deliveryClient.query('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        logger.error(`[outbox] failed to record outcome for row ${row.id}`, err);
      } finally {
        deliveryClient.release();
      }
    }

    client.release();
    return rows.length;
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      inFlight = tick()
        .catch((err) => {
          logger.error('[outbox] dispatcher tick failed', err);
          return 0;
        })
        .finally(() => {
          inFlight = null;
          schedule();
        });
    }, pollIntervalMs);
    // Don't keep the process alive solely for the dispatcher timer.
    if (typeof timer.unref === 'function') timer.unref();
  }

  // Kick off the first cycle immediately.
  inFlight = tick()
    .catch((err) => {
      logger.error('[outbox] dispatcher initial tick failed', err);
      return 0;
    })
    .finally(() => {
      inFlight = null;
      schedule();
    });

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // already logged
        }
      }
    },
    tick,
  };
}

/**
 * A sink that does nothing. Useful for testing and for disabling a subscriber
 * type without removing its outbox rows.
 */
export const noopSink: Sink = {
  name: 'noop',
  async deliver(): Promise<void> {
    // intentionally empty
  },
};

/**
 * A sink that logs each delivered row. Useful as a starting point and for
 * debugging.
 */
export function createLogSink(
  logger: Pick<Console, 'info'> = console,
): Sink {
  return {
    name: 'log',
    async deliver(row: OutboxRow): Promise<void> {
      logger.info(
        `[outbox] deliver ${row.id} subscriber=${row.subscriber} key=${row.idempotency_key}`,
        row.payload,
      );
    },
  };
}

export const logSink: Sink = createLogSink();
```

---

### `src/outbox/index.ts` (new)

```typescript
export {
  startDispatcher,
  noopSink,
  logSink,
  createLogSink,
} from './dispatcher.js';
export type {
  Sink,
  OutboxRow,
  DispatcherOptions,
  DispatcherHandle,
} from './dispatcher.js';
```

---

### `database/schema.sql` (additions)

Append the following to `database/schema.sql`:

```sql
-- Transactional outbox for downstream event delivery.
-- One row per (applied event, subscriber type). Written inside the page
-- transaction so rolled-back pages produce no rows.
CREATE TABLE IF NOT EXISTS outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        text NOT NULL,
  subscriber      text NOT NULL,
  payload         jsonb NOT NULL,
  -- Stable idempotency key: unique per (event, subscriber). Sinks must treat
  -- redelivery of the same key as a no-op (at-least-once delivery).
  idempotency_key text NOT NULL,
  state           text NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'delivered', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  locked_by       text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  dead_at         timestamptz,
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox (next_attempt_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS outbox_event_idx ON outbox (event_id);
```

---

### `src/indexer/stellar.ts` (wiring)

Add the following near the top of `src/indexer/stellar.ts` (imports) and at the end of the indexer startup function. Adjust the surrounding code to match the existing structure.

```typescript
import { startDispatcher, logSink, noopSink } from '../outbox/index.js';
import type { DispatcherHandle } from '../outbox/index.js';
```

Inside the indexer startup (after the pool is created and before/while the indexer loop runs):

```typescript
// Start the transactional outbox dispatcher alongside the indexer.
// It delivers rows written by the page transaction to registered sinks.
const outboxDispatcher: DispatcherHandle = startDispatcher(
  pool,
  [noopSink, logSink],
  { logger: console },
);

// Ensure the dispatcher is stopped on shutdown.
const shutdown = async (): Promise<void> => {
  await outboxDispatcher.stop();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
```

---

### `docs/architecture.md` (additions)

Append a section:

```markdown
## Transactional outbox

Downstream side effects (webhooks, cache purges, message-bus publishing) are not
performed directly by the indexer. Instead, the indexer writes one row per
(applied event, subscriber type) into the `outbox` table **inside the same page
transaction** that applies the events. This guarantees:

- **Rolled-back pages produce no outbox rows** — the rows are rolled back with
  the page.
- **Crash after commit but before delivery results in delivery on restart** —
  the committed rows remain `pending` and are picked up by the dispatcher.

A dispatcher (`src/outbox/dispatcher.ts`) leases pending rows using
`SELECT ... FOR UPDATE SKIP LOCKED` together with a `locked_until` lease. This
ensures **multiple dispatchers never deliver the same row concurrently**: a row
is only visible to one dispatcher at a time, and a crashed dispatcher's lease
expires so the row becomes reclaimable.

### Delivery semantics

Delivery is **at-least-once**. Each outbox row carries a stable
`idempotency_key` that is unique per (event, subscriber type). Sinks **must**
treat redelivery of the same key as a no-op. This is the contract that makes
retries and crash recovery safe.

### Retries and dead-lettering

On failure, a row's `attempts` is incremented and `next_attempt_at` is set using
exponential backoff (base `backoffBaseMs`, capped at `backoffMaxMs`). After
`max_attempts` failures the row transitions to the `dead` state (dead-letter)
and is no longer retried. Operators can inspect `dead` rows and requeue them by
resetting `state = 'pending'`, `attempts = 0`, and `next_attempt_at = now()`.

### Sinks

Sinks implement `{ name, deliver(row): Promise<void> }`. Two sinks ship by
default:

- `noop` — does nothing (useful for disabling a subscriber type).
- `log` — logs each delivered row (useful for debugging and as a starting
  point).