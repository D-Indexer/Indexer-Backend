import type { Pool, PoolClient } from 'pg';
import { decodeEvent, decodeTopic, DecodedEvent, EventDecodeError } from './decode';
import { applyEvent } from './handlers';
import {
  EventSource,
  GetEventsParams,
  GetEventsResult,
  LedgerRangeError,
  RawEvent,
  RpcAbortError,
  isAbortError,
} from './rpc';
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
} as const;

export type IndexerStatus = 'ok' | 'error' | 'retention_gap';
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
   * Poll interval used while the indexer is behind the chain tip. Defaults to
   * `pollIntervalMs`; never exceeds it, so idle RPC usage does not increase.
   */
  catchUpIntervalMs?: number;
  /** Ledger close time assumed when the RPC reports no `ledgerClosedAt`. */
  ledgerCloseTimeMs?: number;
};

export type IndexerDependencies = {
  db: Db;
  rpc: EventSource;
  config: IndexerConfig;
  /** Aborted on shutdown: cancels in-flight RPC calls and retry sleeps. */
  signal?: AbortSignal;
};

export type PageResult = { applied: number; ignored: number; rejected: number; duplicates: number };

/** Stellar closes a ledger roughly every 5 s; used when the RPC omits `ledgerClosedAt`. */
export const DEFAULT_LEDGER_CLOSE_TIME_MS = 5000;

/** How far behind the chain tip the indexer is, in ledgers. */
export type ChainLag = { lagLedgers: number; latestLedger: number; scannedLedger: number };

/**
 * Delay before the next tick, adapted to how far the indexer is behind the
 * chain tip. Caught up (or ahead) keeps the configured interval; behind, the
 * delay shrinks in proportion to the lag so events become queryable sooner,
 * but never below `minIntervalMs` and never above `pollIntervalMs`.
 */
export function adaptiveDelay(
  config: Pick<IndexerConfig, 'pollIntervalMs' | 'catchUpIntervalMs' | 'ledgerCloseTimeMs'>,
  lag: ChainLag | null
): number {
  const max = config.pollIntervalMs;
  if (!lag || lag.lagLedgers <= 0) return max;
  const closeTime = config.ledgerCloseTimeMs ?? DEFAULT_LEDGER_CLOSE_TIME_MS;
  const min = Math.min(config.catchUpIntervalMs ?? max, max);
  return Math.max(min, Math.min(max, lag.lagLedgers * closeTime));
}

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
  if (state[STATE.cursor]) {
    return { params: { contractId, limit, cursor: state[STATE.cursor]! }, fromConfig: false };
  }

  const fromState = Number(state[STATE.startLedger]);
  if (fromState > 0) return { params: { contractId, limit, startLedger: fromState }, fromConfig: false };
  if (deps.config.startLedger) {
    return { params: { contractId, limit, startLedger: deps.config.startLedger }, fromConfig: true };
  }

  const { oldestLedger } = await deps.rpc.getHealth(deps.signal);
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
 * Fetch and persist one page. Returns the number of events in the page so the
 * caller can keep paging while it is full, plus how far behind the chain tip
 * the page left the indexer.
 */
export async function pollOnce(
  deps: IndexerDependencies
): Promise<{ events: number; result: PageResult; lag: ChainLag }> {
  const state = await readState(deps.db);
  const { params, fromConfig } = await nextRequest(deps, state);

  let page: GetEventsResult;
  try {
    page = await deps.rpc.getEvents(params, deps.signal);
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

    // Resume from the oldest retained ledger and record what was missed.
    const resumeAt = err.oldestLedger + 1;
    logger.warn(
      fromConfig
        ? 'INDEXER_START_LEDGER is older than the RPC retains; starting at the oldest retained ledger'
        : 'Retention gap: skipping to the oldest retained ledger (INDEXER_ON_RETENTION_GAP=skip)',
      { missedFrom: requested, resumeAt }
    );
    await writeState(deps.db, {
      [STATE.lastGap]: JSON.stringify({
        missedFrom: requested,
        resumedAt: resumeAt,
        at: new Date().toISOString(),
      }),
    });
    page = await deps.rpc.getEvents(
      {
        contractId: params.contractId,
        limit: params.limit,
        startLedger: resumeAt,
      },
      deps.signal
    );
  }

  // Shutdown requested while fetching: drop the page instead of committing it.
  if (deps.signal?.aborted) throw new RpcAbortError();

  const result = await processPage(deps.db, deps.config.contractId, page);
  if (page.events.length > 0) {
    logger.info('Indexed events', { ...result, lastLedger: page.events[page.events.length - 1].ledger });
  }
  const scanned = scannedLedger(page);
  const lag: ChainLag = {
    lagLedgers: Math.max(0, page.latestLedger - scanned),
    latestLedger: page.latestLedger,
    scannedLedger: scanned,
  };
  return { events: page.events.length, result, lag };
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
  let lag: ChainLag | null = null;

  const tick = async () => {
    try {
      for (let page = 0; page < maxPages && !stopped; page++) {
        const polled = await pollOnce(deps);
        lag = polled.lag;
        if (polled.events < deps.config.pageLimit) break; // caught up
      }
      failures = 0;
    } catch (err) {
      if (isAbortError(err) || stopped) return; // shutting down: no error state, no retry
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RetentionGapError) {
        logger.error('Indexer halted: retention gap', { error: message });
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
      inFlight = tick().then(() =>
        schedule(failures === 0 ? adaptiveDelay(deps.config, lag) : backoffDelay(deps.config, failures))
      );
    }, delay);
  };

  const onAbort = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  deps.signal?.addEventListener('abort', onAbort, { once: true });

  logger.info('Indexer started', {
    contractId: deps.config.contractId,
    pollIntervalMs: deps.config.pollIntervalMs,
    pageLimit: deps.config.pageLimit,
    maxPagesPerTick: maxPages,
  });
  schedule(0);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      deps.signal?.removeEventListener('abort', onAbort);
      await inFlight;
      logger.info('Indexer stopped');
    },
  };
}
