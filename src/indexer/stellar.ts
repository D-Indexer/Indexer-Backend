import type { Pool, PoolClient } from 'pg';
import { decodeEvent, decodeTopic, DecodedEvent, EventDecodeError } from './decode';
import { applyEvent } from './handlers';
import { EventSource, GetEventsParams, GetEventsResult, LedgerRangeError, RawEvent } from './rpc';
import { logger } from '../utils/logger';
import { runWithContext } from '../utils/context';
import { insertContractEvent, toStoredXdr } from './xdrStorage';
import { ledgerFromCursor, readState, STATE, writeState } from './state';
import { ensurePartitions } from './partitions';

export { ledgerFromCursor, readState, STATE, writeState } from './state';
export {
  ensurePartitions,
  PARTITION_LEDGER_SPAN,
  PARTITION_LOOKAHEAD,
  partitionNameForLedger,
} from './partitions';

/** Subscriber types that receive an outbox row for every applied event. */
export const OUTBOX_SUBSCRIBERS = ['webhook', 'changes'] as const;
export type OutboxSubscriber = (typeof OUTBOX_SUBSCRIBERS)[number];

/** Stable idempotency key for an outbox row; sinks must dedupe on it. */
export function outboxIdempotencyKey(eventId: string, subscriber: string): string {
  return `${eventId}:${subscriber}`;
}

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
};

export type IndexerDependencies = { db: Db; rpc: EventSource; config: IndexerConfig };

export type PageResult = { applied: number; ignored: number; rejected: number; duplicates: number };

/** Channel used to announce committed pages to API replicas. */
export const INDEXED_CHANNEL = 'folder_indexed';

/** Postgres NOTIFY payloads must stay below 8000 bytes. */
export const MAX_NOTIFY_PAYLOAD_BYTES = 8000;

export type IndexedNotification = {
  last_ledger: number;
  /** Compact list of affected entity keys; empty when `full_refresh` is set. */
  keys: string[];
  /** True when the key list was truncated; consumers must re-read all state. */
  full_refresh: boolean;
};

/**
 * Build the `folder_indexed` payload for a committed page, truncating the key
 * list so the serialized JSON stays under the NOTIFY payload limit. When even
 * a single key would overflow, fall back to a full-refresh signal.
 */
export function buildIndexedNotification(lastLedger: number, keys: Iterable<string>): string {
  const unique = [...new Set(keys)];
  const encode = (list: string[], fullRefresh: boolean) =>
    JSON.stringify({ last_ledger: lastLedger, keys: list, full_refresh: fullRefresh } satisfies IndexedNotification);

  const full = encode(unique, false);
  if (Buffer.byteLength(full, 'utf8') <= MAX_NOTIFY_PAYLOAD_BYTES) return full;

  // Drop keys from the end until the payload fits, then flag a full refresh so
  // consumers know the list is incomplete.
  let kept = unique.length;
  while (kept > 0) {
    kept--;
    const candidate = encode(unique.slice(0, kept), true);
    if (Buffer.byteLength(candidate, 'utf8') <= MAX_NOTIFY_PAYLOAD_BYTES) return candidate;
  }
  return encode([], true);
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

function scannedLedger(page: GetEventsResult): number {
  try {
    return ledgerFromCursor(page.cursor);
  } catch {
    return page.events.length ? page.events[page.events.length - 1].ledger : page.latestLedger;
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
 * Entity keys touched by an event, used to keep NOTIFY payloads compact.
 * Falls back to the event's contract and topic when no finer key is known.
 */
function affectedEntityKeys(event: RawEvent): string[] {
  const keys: string[] = [];
  try {
    const decoded = decodeEvent(event);
    if (decoded && typeof decoded === 'object') {
      const record = decoded as unknown as Record<string, unknown>;
      for (const field of ['key', 'id', 'address', 'account', 'folderId', 'folder_id']) {
        const value = record[field];
        if (typeof value === 'string' && value.length > 0) keys.push(value);
      }
    }
  } catch {
    // Undecodable events were rejected or ignored; nothing to announce.
  }
  if (keys.length === 0) {
    const topic = decodeTopic(event);
    if (topic) keys.push(topic);
  }
  return keys;
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

  // Raw XDR is stored as bytes (BYTEA), not base64 text; see xdrStorage.ts.
  // XDR that is not canonical base64 cannot round-trip, so such an event is
  // rejected (it would not decode anyway) and its text is kept verbatim.
  const stored = toStoredXdr(event);
  if (stored.error) {
    decoded = null;
    error ??= stored.error;
  }

  const status = error ? 'rejected' : decoded ? 'applied' : 'ignored';
  const inserted = await insertContractEvent(client, {
    event,
    contractId,
    topic,
    stored,
    data: decoded,
    status,
    error,
  });

  if (!inserted) return 'duplicate';
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
    await enqueueOutbox(client, event, decoded);
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
 * Insert one outbox row per subscriber for an applied event. Runs inside the
 * page transaction, so a rolled-back page leaves no rows and a committed page
 * always has them (crash-safe delivery on restart). ON CONFLICT keeps replays
 * idempotent.
 */
async function enqueueOutbox(client: PoolClient, event: RawEvent, decoded: DecodedEvent): Promise<void> {
  const payload = JSON.stringify({
    id: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    txHash: event.txHash,
    contractId: event.contractId,
    topic: decodeTopic(event) ?? '',
    event: decoded,
  });
  for (const subscriber of OUTBOX_SUBSCRIBERS) {
    await client.query(
      `INSERT INTO outbox (idempotency_key, event_id, subscriber, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [outboxIdempotencyKey(event.id, subscriber), event.id, subscriber, payload]
    );
  }
}

/**
 * Persist one getEvents page and advance the cursor in a single transaction.
 * Events already stored (same RPC event id) are skipped, so replaying a page
 * after a crash or a manual cursor rewind is safe.
 *
 * PgBouncer: transaction-pooling safe. Everything (inserts, SAVEPOINTs, the
 * cursor write and pg_notify, which Postgres delivers on commit) runs inside
 * one BEGIN ... COMMIT on one checked-out client, with no session state.
 */
export async function processPage(db: Db, contractId: string, page: GetEventsResult): Promise<PageResult> {
  return runWithContext({ pageId: page.cursor, cursor: page.cursor }, () =>
    processPageInContext(db, contractId, page)
  );
}

async function processPageInContext(db: Db, contractId: string, page: GetEventsResult): Promise<PageResult> {
  const result: PageResult = { applied: 0, ignored: 0, rejected: 0, duplicates: 0 };
  const affectedKeys = new Set<string>();
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    for (const event of page.events) {
      if (event.contractId !== contractId) continue;
      const outcome = await storeEvent(client, contractId, event);
      if (outcome === 'duplicate') result.duplicates++;
      else result[outcome]++;
      if (outcome === 'applied') {
        for (const key of affectedEntityKeys(event)) affectedKeys.add(key);
      }
    }
    // The paging cursor encodes how far the RPC scanned (the chain tip for a
    // partial page), which is further than the last event's ledger.
    const lastLedger = scannedLedger(page);
    // Keep partitions ready ahead of the chain tip so inserts never fall into
    // the default partition during normal operation.
    await ensurePartitions(client, Math.max(lastLedger, page.latestLedger));
    await writeState(client, {
      [STATE.cursor]: page.cursor,
      [STATE.startLedger]: null,
      [STATE.lastLedger]: String(lastLedger),
      [STATE.lastSuccessAt]: new Date().toISOString(),
      [STATE.status]: 'ok',
      [STATE.lastError]: null,
    });
    // Postgres delivers NOTIFY only on commit, so a rolled-back page emits
    // nothing. Exactly one notification is sent per committed page.
    await client.query('SELECT pg_notify($1, $2)', [
      INDEXED_CHANNEL,
      buildIndexedNotification(lastLedger, affectedKeys),
    ]);
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
 * Fetch and persist one page. Returns the number of events in the page so the
 * caller can keep paging while it is full.
 */
export async function pollOnce(deps: IndexerDependencies): Promise<{ events: number; result: PageResult }> {
  const state = await readState(deps.db);
  const { params, fromConfig } = await nextRequest(deps, state);
  const pageId = params.cursor ?? `start:${params.startLedger}`;
  return runWithContext({ pageId, cursor: params.cursor }, () => pollOnceInContext(deps, params, fromConfig));
}

async function pollOnceInContext(
  deps: IndexerDependencies,
  params: GetEventsParams,
  fromConfig: boolean
): Promise<{ events: number; result: PageResult }> {

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
    page = await deps.rpc.getEvents({
      contractId: params.contractId,
      limit: params.limit,
      startLedger: resumeAt,
    });
  }

  // Ensure partitions exist for the scanned range before inserting, even when
  // the page is empty (e.g. a caught-up poll at the chain tip).
  await ensurePartitions(deps.db, Math.max(scannedLedger(page), page.latestLedger));

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
