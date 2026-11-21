import type { Pool, PoolClient } from 'pg';
import os from 'node:os';
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
  leaderId: 'leader_id',
  leaderSince: 'leader_since',
  leaderHeartbeatAt: 'leader_heartbeat_at',
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
   * How many pages to fetch ahead of the page being committed while catching
   * up. Defaults to 1; 0 disables prefetching (strictly sequential).
   */
  prefetchPages?: number;
  /** How often a standby retries the advisory lock. Defaults to 5000ms. */
  leaderRetryMs?: number;
  /** Identifies this process in indexer_state leader info. Defaults to host:pid. */
  instanceId?: string;
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

/**
 * Write indexer state in two round trips: one upsert for the keys that get a
 * value, one DELETE for the keys that are cleared.
 */
export async function writeState(
  db: Pick<Pool, 'query'>,
  entries: Partial<Record<string, string | null>>
): Promise<void> {
  const upserts: [string, string][] = [];
  const deletes: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === undefined) deletes.push(key);
    else upserts.push([key, value]);
  }

  if (upserts.length > 0) {
    await db.query(
      `INSERT INTO indexer_state (key, value, updated_at)
       SELECT key, value, NOW() FROM unnest($1::text[], $2::text[]) AS t(key, value)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [upserts.map(([key]) => key), upserts.map(([, value]) => value)]
    );
  }
  if (deletes.length > 0) {
    await db.query('DELETE FROM indexer_state WHERE key = ANY($1::text[])', [deletes]);
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

/** One event of a page, decoded up front so the insert is a single round trip. */
type PreparedEvent = {
  event: RawEvent;
  topic: string;
  decoded: DecodedEvent | null;
  error: string | null;
  status: 'applied' | 'ignored' | 'rejected';
};

function prepareEvent(event: RawEvent): PreparedEvent {
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
  return { event, topic, decoded, error, status };
}

/**
 * Insert a whole page into contract_events with one statement. Returns the ids
 * that were actually inserted (in page order); ids already stored are skipped.
 */
async function insertEvents(
  client: PoolClient,
  contractId: string,
  prepared: PreparedEvent[]
): Promise<Set<string>> {
  if (prepared.length === 0) return new Set();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO contract_events
       (id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status, error)
     SELECT id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status, error
       FROM unnest(
         $1::text[], $2::int[], $3::timestamptz[], $4::text[], $5::text[], $6::text[],
         $7::text[][], $8::text[], $9::jsonb[], $10::text[], $11::text[]
       ) AS t(id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status, error)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      prepared.map((p) => p.event.id),
      prepared.map((p) => p.event.ledger),
      prepared.map((p) => p.event.ledgerClosedAt),
      prepared.map((p) => p.event.txHash),
      prepared.map(() => contractId),
      prepared.map((p) => p.topic),
      prepared.map((p) => p.event.topic),
      prepared.map((p) => p.event.value),
      prepared.map((p) => (p.decoded ? JSON.stringify(p.decoded) : null)),
      prepared.map((p) => p.status),
      prepared.map((p) => p.error),
    ]
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Apply one newly inserted event to the read model under its own savepoint.
 * A deterministic DB error means the event contradicts the read model. Record
 * it and move on rather than blocking the indexer; anything else (connection
 * loss, etc.) aborts the page so it is retried.
 */
async function applyStoredEvent(
  client: PoolClient,
  prepared: PreparedEvent
): Promise<'applied' | 'ignored' | 'rejected'> {
  const { event, topic, decoded, error, status } = prepared;
  if (!decoded) {
    if (error) logger.warn('Rejected malformed contract event', { id: event.id, topic, error });
    return status as 'ignored' | 'rejected';
  }

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
    const prepared = page.events
      .filter((event) => event.contractId === contractId)
      .map((event) => prepareEvent(event));
    const inserted = await insertEvents(client, contractId, prepared);
    for (const item of prepared) {
      if (!inserted.has(item.event.id)) {
        result.duplicates++;
        continue;
      }
      result[await applyStoredEvent(client, item)]++;
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
 * Fetch one page, recovering from a retention gap by resuming at the oldest
 * ledger the RPC still retains.
 */
async function fetchPage(deps: IndexerDependencies, request: NextRequest): Promise<GetEventsResult> {
  const { params, fromConfig } = request;
  try {
    return await deps.rpc.getEvents(params);
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
    return deps.rpc.getEvents({
      contractId: params.contractId,
      limit: params.limit,
      startLedger: resumeAt,
    });
  }
}

/**
 * Fetch and persist one page. Returns the number of events in the page so the
 * caller can keep paging while it is full.
 */
export async function pollOnce(deps: IndexerDependencies): Promise<{ events: number; result: PageResult }> {
  const state = await readState(deps.db);
  const request = await nextRequest(deps, state);
  const page = await fetchPage(deps, request);

  const result = await processPage(deps.db, deps.config.contractId, page);
  if (page.events.length > 0) {
    logger.info('Indexed events', { ...result, lastLedger: page.events[page.events.length - 1].ledger });
  }
  return { events: page.events.length, result };
}

/**
 * Catch up by fetching pages ahead of the one being committed. Page N+1 is
 * requested while page N commits, up to `prefetchPages` pages in flight.
 * Pages are always committed in RPC order, and a failed commit drops every
 * prefetched page so nothing later than the failure is ever committed.
 */
export async function catchUp(
  deps: IndexerDependencies,
  maxPages: number,
  isStopped: () => boolean = () => false
): Promise<void> {
  const depth = Math.max(0, deps.config.prefetchPages ?? 1);
  if (depth === 0) {
    for (let page = 0; page < maxPages && !isStopped(); page++) {
      const { events } = await pollOnce(deps);
      if (events < deps.config.pageLimit) break; // caught up
    }
    return;
  }

  const state = await readState(deps.db);
  const first = await nextRequest(deps, state);
  const queue: Promise<GetEventsResult>[] = [fetchPage(deps, first)];
  let next: NextRequest | null = null;

  try {
    for (let page = 0; page < maxPages && !isStopped(); page++) {
      const current = await queue.shift()!;
      // Keep the pipeline full: request the page after this one before committing.
      if (next && queue.length < depth) queue.push(fetchPage(deps, next));
      next = null;

      const result = await processPage(deps.db, deps.config.contractId, current);
      if (current.events.length > 0) {
        logger.info('Indexed events', {
          ...result,
          lastLedger: current.events[current.events.length - 1].ledger,
        });
      }
      if (current.events.length < deps.config.pageLimit) break; // caught up

      next = {
        params: {
          contractId: deps.config.contractId,
          limit: deps.config.pageLimit,
          cursor: current.cursor,
        },
        fromConfig: false,
      };
      if (queue.length < depth) queue.push(fetchPage(deps, next));
    }
  } catch (err) {
    // Discard prefetched pages: they are re-fetched from the committed cursor.
    queue.length = 0;
    throw err;
  }
}

export type RunningIndexer = {
  /** Stop polling; resolves once any in-flight poll has finished. */
  stop: () => Promise<void>;
};

/**
 * Session-level advisory lock that makes exactly one indexer process the writer.
 * The lock is keyed from the contract ID, so indexers for different contracts
 * (or databases) never contend. It is held by a dedicated pooled connection and
 * released automatically by Postgres when that session ends (crash, SIGKILL).
 */
export type LeaderLock = {
  /** True while this process holds the lock. */
  readonly held: boolean;
  /** Try to become leader. Returns true when the lock is held afterwards. */
  acquire: () => Promise<boolean>;
  /** Release the lock and its connection. Safe to call when not held. */
  release: () => Promise<void>;
};

/** Stable 64-bit advisory lock key derived from the contract ID. */
export function leaderLockKey(contractId: string): bigint {
  // FNV-1a 64-bit over the contract strkey, mapped into signed bigint range.
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(contractId, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return BigInt.asIntN(64, hash);
}

export function createLeaderLock(db: Db, contractId: string): LeaderLock {
  const key = leaderLockKey(contractId);
  let client: PoolClient | null = null;

  return {
    get held() {
      return client !== null;
    },
    async acquire() {
      if (client) return true;
      const candidate = await db.connect();
      try {
        const { rows } = await candidate.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [key.toString()]
        );
        if (!rows[0]?.locked) {
          candidate.release();
          return false;
        }
        client = candidate;
        return true;
      } catch (err) {
        candidate.release(true);
        throw err;
      }
    },
    async release() {
      const held = client;
      if (!held) return;
      client = null;
      try {
        await held.query('SELECT pg_advisory_unlock($1)', [key.toString()]);
      } finally {
        held.release();
      }
    },
  };
}

export function createIndexer(deps: IndexerDependencies): RunningIndexer {
  const maxPages = deps.config.maxPagesPerTick ?? 50;
  const retryMs = deps.config.leaderRetryMs ?? 5000;
  const instanceId = deps.config.instanceId ?? `${os.hostname()}:${process.pid}`;
  const lock = createLeaderLock(deps.db, deps.config.contractId);
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let failures = 0;
  let inFlight: Promise<void> = Promise.resolve();

  const becomeLeader = async () => {
    await writeState(deps.db, {
      [STATE.leaderId]: instanceId,
      [STATE.leaderSince]: new Date().toISOString(),
      [STATE.leaderHeartbeatAt]: new Date().toISOString(),
    });
    logger.info('Indexer is leader', { instanceId, contractId: deps.config.contractId });
  };

  const stepDown = async () => {
    await lock.release();
    await writeState(deps.db, {
      [STATE.leaderId]: null,
      [STATE.leaderSince]: null,
      [STATE.leaderHeartbeatAt]: null,
    }).catch(() => undefined);
    logger.info('Indexer released leadership', { instanceId });
  };

  const tick = async () => {
    if (!lock.held) {
      let acquired = false;
      try {
        acquired = await lock.acquire();
      } catch (err) {
        failures++;
        logger.error('Indexer leader lock attempt failed', {
          error: err instanceof Error ? err.message : String(err),
          failures,
        });
        return;
      }
      if (!acquired) {
        logger.info('Indexer is standby: another process holds the writer lock', {
          instanceId,
          retryMs,
        });
        return;
      }
      await becomeLeader();
    }

    try {
      await catchUp(deps, maxPages, () => stopped);
      failures = 0;
      await writeState(deps.db, { [STATE.leaderHeartbeatAt]: new Date().toISOString() }).catch(
        () => undefined
      );
    } catch (err) {
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
      inFlight = tick().then(() => schedule(lock.held ? backoffDelay(deps.config, failures) : retryMs));
    }, delay);
  };

  logger.info('Indexer started', {
    contractId: deps.config.contractId,
    pollIntervalMs: deps.config.pollIntervalMs,
    pageLimit: deps.config.pageLimit,
    instanceId,
  });
  schedule(0);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      await stepDown();
      logger.info('Indexer stopped');
    },
  };
}

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
      await catchUp(deps, maxPages, () => stopped);
      failures = 0;
    } catch (err) {
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
      inFlight = tick().then(() => schedule(backoffDelay(deps.config, failures)));
    }, delay);
  };

  logger.info('Indexer started', {
    contractId: deps.config.contractId,
    pollIntervalMs: deps.config.pollIntervalMs,
    pageLimit: deps.config.pageLimit,
    prefetchPages: deps.config.prefetchPages ?? 1,
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
