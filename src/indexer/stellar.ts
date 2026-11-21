import type { Pool, PoolClient } from 'pg';
import { decodeEvent, decodeTopic, DecodedEvent, EventDecodeError } from './decode';
import { applyEvent } from './handlers';
import { EventSource, GetEventsParams, GetEventsResult, LedgerRangeError, RawEvent } from './rpc';
import { logger } from '../utils/logger';

/** indexer_state keys. */
export const STATE = {
  cursor: 'cursor',
  startLedger: 'start_ledger',
  lastLedger: 'last_ledger',
  lastSuccessAt: 'last_success_at',
  status: 'status',
  lastError: 'last_error',
  lastGap: 'last_gap',
  cursorRecovered: 'cursor_recovered',
} as const;

export type IndexerStatus = 'ok' | 'error' | 'retention_gap' | 'cursor_invalid';
export type RetentionGapPolicy = 'halt' | 'skip';

export type Db = Pick<Pool, 'connect' | 'query'>;

export type IndexerConfig = {
  contractId: string;
  pollIntervalMs: number;
  pageLimit: number;
  /** First ledger to index when there is no saved cursor. Defaults to the RPC's oldest ledger. */
  startLedger?: number;
  onRetentionGap: RetentionGapPolicy;
  maxBackoffMs: number;
  /** Max pages fetched back-to-back in one tick while catching up. */
  maxPagesPerTick?: number;
  /**
   * Max attempts to resume after a retention gap while the RPC's oldest retained
   * ledger keeps moving forward. Defaults to 5.
   */
  maxGapResumeAttempts?: number;
};

export type IndexerDependencies = { db: Db; rpc: EventSource; config: IndexerConfig };

export type PageResult = { applied: number; ignored: number; rejected: number; duplicates: number };

export class RetentionGapError extends Error {
  constructor(
    readonly requestedLedger: number,
    readonly oldestLedger: number
  ) {
    super(
      `Saved cursor is at ledger ${requestedLedger}, but the RPC only retains ledgers from ` +
        `${oldestLedger}. Events in ${requestedLedger}..${oldestLedger - 1} are no longer available ` +
        'from getEvents. See docs/operations.md#retention-gap to recover.'
    );
    this.name = 'RetentionGapError';
  }
}

/** Ledger encoded in an RPC paging cursor / event id (a TOID: ledger << 32 | tx/op bits). */
export function ledgerFromCursor(cursor: string): number {
  const toid = BigInt(cursor.split('-')[0]);
  return Number(toid >> 32n);
}

/** An RPC paging cursor: `<TOID>-<op index>`, both decimal, e.g. `0024284788768636927-4294967295`. */
const CURSOR_PATTERN = /^\d{1,20}-\d{1,10}$/;

/** True when `cursor` is a well-formed RPC paging cursor pointing at a positive ledger. */
export function isValidCursor(cursor: string): boolean {
  if (!CURSOR_PATTERN.test(cursor)) return false;
  try {
    return ledgerFromCursor(cursor) > 0;
  } catch {
    return false;
  }
}

export class CursorInvalidError extends Error {
  constructor(readonly cursor: string) {
    super(
      `Saved cursor ${JSON.stringify(cursor)} is not a valid RPC paging cursor and there is no valid ` +
        'last_ledger to fall back to. Run `npm run indexer -- reset-cursor <ledger>` to resume ' +
        'indexing. See docs/operations.md#invalid-cursor.'
    );
    this.name = 'CursorInvalidError';
  }
}

function scannedLedger(page: GetEventsResult): number {
  try {
    return ledgerFromCursor(page.cursor);
  } catch {
    return page.events.length ? page.events[page.events.length - 1].ledger : page.latestLedger;
  }
}

export async function readState(db: Pick<Pool, 'query'>): Promise<Partial<Record<string, string>>> {
  const { rows } = await db.query<{ key: string; value: string }>('SELECT key, value FROM indexer_state');
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function writeState(
  db: Pick<Pool, 'query'>,
  entries: Partial<Record<string, string | null>>
): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === undefined) {
      await db.query('DELETE FROM indexer_state WHERE key = $1', [key]);
    } else {
      await db.query(
        `INSERT INTO indexer_state (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
      );
    }
  }
}

/**
 * Postgres errors that are deterministic for a given event: data exceptions
 * (class 22, e.g. out of range) and constraint violations (class 23).
 * Retrying would fail forever, so the event is rejected instead.
 */
export function isDeterministicDbError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'));
}

/**
 * Advisory lock key held by the indexer process and by `retry-rejected`, so the
 * two never write the read model at the same time.
 */
export const INDEXER_LOCK_KEY = 0x1d1e7e5;

/** Take the indexer lock for the rest of the session; false when it is held elsewhere. */
export async function tryLockIndexer(client: Pick<PoolClient, 'query'>): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
    INDEXER_LOCK_KEY,
  ]);
  return rows[0]?.locked === true;
}

export async function unlockIndexer(client: Pick<PoolClient, 'query'>): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [INDEXER_LOCK_KEY]);
}

export type RejectedEventRow = {
  id: string;
  ledger: number;
  ledger_closed_at: Date;
  topic: string;
  topic_xdr: string[];
  value_xdr: string;
};

export type RetryOptions = {
  /** Only retry events whose decoded topic is this one. */
  topic?: string;
  /** Only retry events at or after this ledger. */
  sinceLedger?: number;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
};

export type RetryOutcome = 'applied' | 'ignored' | 'rejected';

export type RetryResult = {
  scanned: number;
  applied: number;
  ignored: number;
  rejected: number;
  changes: { id: string; topic: string; outcome: RetryOutcome; error: string | null }[];
};

/**
 * Re-decode stored rejected events from their raw XDR and apply the ones that
 * now decode, in ledger/TOID order. Each event is applied under a savepoint so
 * a single failure doesn't abort the batch. Idempotent: events that still fail
 * to decode stay rejected, and applied events are no longer selected.
 */
export async function retryRejected(db: Db, options: RetryOptions = {}): Promise<RetryResult> {
  const result: RetryResult = { scanned: 0, applied: 0, ignored: 0, rejected: 0, changes: [] };
  const client = await db.connect();

  try {
    if (!(await tryLockIndexer(client))) {
      throw new Error('The indexer is running (advisory lock held); stop it before retrying rejected events.');
    }
    await client.query('BEGIN');
    const { rows } = await client.query<RejectedEventRow>(
      `SELECT id, ledger, ledger_closed_at, topic, topic_xdr, value_xdr
         FROM contract_events
        WHERE status = 'rejected'
          AND ($1::text IS NULL OR topic = $1)
          AND ($2::int IS NULL OR ledger >= $2)
        ORDER BY ledger, id`,
      [options.topic ?? null, options.sinceLedger ?? null]
    );

    for (const row of rows) {
      result.scanned++;
      const raw: RawEvent = {
        type: 'contract',
        ledger: row.ledger,
        ledgerClosedAt: new Date(row.ledger_closed_at).toISOString(),
        contractId: '',
        id: row.id,
        txHash: '',
        topic: row.topic_xdr,
        value: row.value_xdr,
      };

      let decoded: DecodedEvent | null = null;
      let error: string | null = null;
      try {
        decoded = decodeEvent(raw);
      } catch (err) {
        if (!(err instanceof EventDecodeError)) throw err;
        error = err.message;
      }

      if (!decoded) {
        const outcome: RetryOutcome = error ? 'rejected' : 'ignored';
        result[outcome]++;
        result.changes.push({ id: row.id, topic: row.topic, outcome, error });
        if (!options.dryRun) {
          await client.query(
            `UPDATE contract_events
                SET status = $2, data = NULL, error = $3,
                    retry_count = retry_count + 1, last_retry_at = NOW()
              WHERE id = $1`,
            [row.id, outcome, error]
          );
        }
        continue;
      }

      await client.query('SAVEPOINT retry_event');
      try {
        await applyEvent(client, decoded, new Date(row.ledger_closed_at));
        await client.query('RELEASE SAVEPOINT retry_event');
        result.applied++;
        result.changes.push({ id: row.id, topic: row.topic, outcome: 'applied', error: null });
        if (!options.dryRun) {
          await client.query(
            `UPDATE contract_events
                SET status = 'applied', data = $2, error = NULL,
                    retry_count = retry_count + 1, last_retry_at = NOW()
              WHERE id = $1`,
            [row.id, JSON.stringify(decoded)]
          );
        }
      } catch (err) {
        if (!isDeterministicDbError(err)) throw err;
        await client.query('ROLLBACK TO SAVEPOINT retry_event');
        const message = err instanceof Error ? err.message : String(err);
        result.rejected++;
        result.changes.push({ id: row.id, topic: row.topic, outcome: 'rejected', error: message });
        if (!options.dryRun) {
          await client.query(
            `UPDATE contract_events
                SET status = 'rejected', data = NULL, error = $2,
                    retry_count = retry_count + 1, last_retry_at = NOW()
              WHERE id = $1`,
            [row.id, message]
          );
        }
      }
    }

    if (options.dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await unlockIndexer(client).catch(() => undefined);
    client.release();
  }
}

async function storeEvent(
  client: PoolClient,
  contractId: string,
  event: RawEvent
): Promise<'applied' | 'ignored' | 'rejected' | 'duplicate'> {
  let topic = '';
  let decoded: DecodedEvent | null = null;
  let error: string | null = null;

  try {
    topic = decodeTopic(event) ?? '';
    decoded = decodeEvent(event);
  } catch (err) {
    if (!(err instanceof EventDecodeError)) throw err;
    error = err.message;
  }

  const status = error ? 'rejected' : decoded ? 'applied' : 'ignored';
  const inserted = await client.query(
    `INSERT INTO contract_events
       (id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      event.id,
      event.ledger,
      event.ledgerClosedAt,
      event.txHash,
      contractId,
      topic,
      event.topic,
      event.value,
      decoded ? JSON.stringify(decoded) : null,
      status,
      error,
    ]
  );

  if (inserted.rowCount === 0) return 'duplicate';
  if (!decoded) {
    if (error) logger.warn('Rejected malformed contract event', { id: event.id, topic, error });
    return status as 'ignored' | 'rejected';
  }

  // A deterministic DB error means the event contradicts the read model. Record
  // it and move on rather than blocking the indexer; anything else (connection
  // loss, etc.) aborts the page so it is retried.
  await client.query('SAVEPOINT apply_event');
  try {
    await applyEvent(client, decoded, new Date(event.ledgerClosedAt));
    await client.query('RELEASE SAVEPOINT apply_event');
    return 'applied';
  } catch (err) {
    if (!isDeterministicDbError(err)) throw err;
    await client.query('ROLLBACK TO SAVEPOINT apply_event');
    const message = err instanceof Error ? err.message : String(err);
    await client.query("UPDATE contract_events SET status = 'rejected', error = $2 WHERE id = $1", [
      event.id,
      message,
    ]);
    logger.warn('Rejected contract event the database refused', { id: event.id, topic, error: message });
    return 'rejected';
  }
}

/**
 * Persist one getEvents page and advance the cursor in a single transaction.
 * Events already stored (same RPC event id) are skipped, so replaying a page
 * after a crash or a manual cursor rewind is safe.
 */
export async function processPage(db: Db, contractId: string, page: GetEventsResult): Promise<PageResult> {
  const result: PageResult = { applied: 0, ignored: 0, rejected: 0, duplicates: 0 };
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    for (const event of page.events) {
      if (event.contractId !== contractId) continue;
      const outcome = await storeEvent(client, contractId, event);
      if (outcome === 'duplicate') result.duplicates++;
      else result[outcome]++;
    }
    // The paging cursor encodes how far the RPC scanned (the chain tip for a
    // partial page), which is further than the last event's ledger.
    const lastLedger = scannedLedger(page);
    await writeState(client, {
      [STATE.cursor]: page.cursor,
      [STATE.startLedger]: null,
      [STATE.lastLedger]: String(lastLedger),
      [STATE.lastSuccessAt]: new Date().toISOString(),
      [STATE.status]: 'ok',
      [STATE.lastError]: null,
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

type NextRequest = {
  params: GetEventsParams;
  /** True when the start point came from config on an empty database, not from indexed state. */
  fromConfig: boolean;
};

async function nextRequest(
  deps: IndexerDependencies,
  state: Partial<Record<string, string>>
): Promise<NextRequest> {
  const { contractId, pageLimit: limit } = deps.config;
  const cursor = state[STATE.cursor];
  if (cursor && isValidCursor(cursor)) {
    return { params: { contractId, limit, cursor }, fromConfig: false };
  }
  if (cursor) {
    // A corrupt cursor would make every getEvents call fail, so recover instead:
    // resume from the last ledger we scanned (replaying it is safe) or, failing
    // that, halt and ask an operator to reset the cursor.
    const lastLedger = Number(state[STATE.lastLedger]);
    if (!Number.isInteger(lastLedger) || lastLedger <= 0) {
      throw new CursorInvalidError(cursor);
    }
    logger.warn(
      'Saved cursor is invalid; recovering from last_ledger. Run `npm run indexer -- reset-cursor <ledger>` ' +
        'if this repeats.',
      { cursor, resumeAt: lastLedger }
    );
    await writeState(deps.db, {
      [STATE.cursor]: null,
      [STATE.cursorRecovered]: JSON.stringify({
        invalidCursor: cursor,
        resumedAt: lastLedger,
        at: new Date().toISOString(),
      }),
    });
    return { params: { contractId, limit, startLedger: lastLedger }, fromConfig: false };
  }

  const fromState = Number(state[STATE.startLedger]);
  if (fromState > 0) return { params: { contractId, limit, startLedger: fromState }, fromConfig: false };
  if (deps.config.startLedger) {
    return { params: { contractId, limit, startLedger: deps.config.startLedger }, fromConfig: true };
  }

  const { oldestLedger } = await deps.rpc.getHealth();
  logger.warn(
    'No saved cursor and INDEXER_START_LEDGER is unset; starting at the oldest ledger the RPC retains. ' +
      'Events before it are not indexed.',
    { startLedger: oldestLedger }
  );
  return { params: { contractId, limit, startLedger: oldestLedger }, fromConfig: true };
}

function requestedLedger(params: GetEventsParams): number {
  return params.cursor !== undefined ? ledgerFromCursor(params.cursor) : params.startLedger!;
}

/**
 * Resume after a retention gap at the oldest ledger the RPC still retains.
 *
 * `oldestLedger` is inclusive: `getEvents` with `startLedger = oldestLedger`
 * returns events in that ledger, so resuming at `oldestLedger + 1` would drop
 * them. The window moves forward while we retry, so a resume attempt can itself
 * fall out of range; retry from the new oldest ledger, bounded by
 * `maxGapResumeAttempts`.
 */
async function resumeAfterGap(
  deps: IndexerDependencies,
  params: GetEventsParams,
  requested: number,
  oldestLedger: number
): Promise<GetEventsResult> {
  const maxAttempts = Math.max(1, deps.config.maxGapResumeAttempts ?? 5);
  let resumeAt = oldestLedger;

  for (let attempt = 1; ; attempt++) {
    try {
      const page = await deps.rpc.getEvents({
        contractId: params.contractId,
        limit: params.limit,
        startLedger: resumeAt,
      });
      await writeState(deps.db, {
        [STATE.lastGap]: JSON.stringify({
          missedFrom: requested,
          missedTo: resumeAt - 1,
          resumedAt: resumeAt,
          at: new Date().toISOString(),
        }),
      });
      return page;
    } catch (err) {
      if (!(err instanceof LedgerRangeError) || resumeAt >= err.oldestLedger) throw err;
      if (attempt >= maxAttempts) {
        throw new RetentionGapError(requested, err.oldestLedger);
      }
      logger.warn('Retention window moved while resuming; retrying from the new oldest ledger', {
        attempt,
        maxAttempts,
        resumeAt,
        oldestLedger: err.oldestLedger,
      });
      resumeAt = err.oldestLedger;
    }
  }
}

/**
 * Fetch and persist one page. Returns the number of events in the page so the
 * caller can keep paging while it is full.
 */
export async function pollOnce(deps: IndexerDependencies): Promise<{ events: number; result: PageResult }> {
  const state = await readState(deps.db);
  const { params, fromConfig } = await nextRequest(deps, state);

  let page: GetEventsResult;
  try {
    page = await deps.rpc.getEvents(params);
  } catch (err) {
    if (!(err instanceof LedgerRangeError)) throw err;
    const requested = requestedLedger(params);
    if (requested >= err.oldestLedger) throw err; // ahead of the RPC, not a gap
    const gap = new RetentionGapError(requested, err.oldestLedger);

    // On an empty database nothing indexed is being lost, so INDEXER_START_LEDGER
    // being older than the window just means "as far back as possible".
    if (deps.config.onRetentionGap === 'halt' && !fromConfig) {
      await writeState(deps.db, { [STATE.status]: 'retention_gap', [STATE.lastError]: gap.message });
      throw gap;
    }

    // Resume from the oldest retained ledger (inclusive) and record what was missed.
    logger.warn(
      fromConfig
        ? 'INDEXER_START_LEDGER is older than the RPC retains; starting at the oldest retained ledger'
        : 'Retention gap: skipping to the oldest retained ledger (INDEXER_ON_RETENTION_GAP=skip)',
      { missedFrom: requested, resumeAt: err.oldestLedger }
    );
    page = await resumeAfterGap(deps, params, requested, err.oldestLedger);
  }

  const result = await processPage(deps.db, deps.config.contractId, page);
  if (page.events.length > 0) {
    logger.info('Indexed events', { ...result, lastLedger: page.events[page.events.length - 1].ledger });
  }
  return { events: page.events.length, result };
}

export type RunningIndexer = {
  /** Stop polling; resolves once any in-flight poll has finished. */
  stop: () => Promise<void>;
};

export function backoffDelay(
  config: Pick<IndexerConfig, 'pollIntervalMs' | 'maxBackoffMs'>,
  failures: number
): number {
  if (failures === 0) return config.pollIntervalMs;
  return Math.min(config.pollIntervalMs * 2 ** failures, config.maxBackoffMs);
}

export function createIndexer(deps: IndexerDependencies): RunningIndexer {
  const maxPages = deps.config.maxPagesPerTick ?? 50;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let failures = 0;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async () => {
    try {
      for (let page = 0; page < maxPages && !stopped; page++) {
        const { events } = await pollOnce(deps);
        if (events < deps.config.pageLimit) break; // caught up
      }
      failures = 0;
    } catch (err) {
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RetentionGapError) {
        logger.error('Indexer halted: retention gap', { error: message });
      } else if (err instanceof CursorInvalidError) {
        logger.error('Indexer halted: invalid cursor', { error: message });
        await writeState(deps.db, { [STATE.status]: 'cursor_invalid', [STATE.lastError]: message }).catch(
          () => undefined
        );
      } else {
        logger.error('Indexer poll failed', { error: message, failures });
        await writeState(deps.db, { [STATE.status]: 'error', [STATE.lastError]: message }).catch(
          () => undefined
        );
      }
    }
  };

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = tick().then(() => schedule(backoffDelay(deps.config, failures)));
    }, delay);
  };

  logger.info('Indexer started', {
    contractId: deps.config.contractId,
    pollIntervalMs: deps.config.pollIntervalMs,
    pageLimit: deps.config.pageLimit,
  });
  schedule(0);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      logger.info('Indexer stopped');
    },
  };
}
