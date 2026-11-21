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
  wasmHash: 'wasm_hash',
  wasmUpgrade: 'wasm_upgrade',
} as const;

export type IndexerStatus =
  | 'ok'
  | 'error'
  | 'fatal_db_error'
  | 'retention_gap'
  | 'wasm_upgrade'
  | 'rejection_rate';
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
  /** WASM hashes (hex) the indexer accepts. Empty = accept any hash. */
  wasmAllowList?: string[];
  /** What to do when the contract's WASM hash changes: halt indexing or continue. */
  onWasmUpgrade?: 'halt' | 'continue';
  /** Halt when more than this fraction (0–1) of a page's known events are rejected. */
  maxRejectionRate?: number;
  /** Minimum known events in a page before the rejection-rate breaker can trip. */
  minRejectionSample?: number;
};

export type IndexerDependencies = { db: Db; rpc: EventSource; config: IndexerConfig };

export type PageResult = { applied: number; ignored: number; rejected: number; duplicates: number };

/** Thrown when the contract's WASM hash changed and the policy is to halt. */
export class WasmUpgradeError extends Error {
  constructor(
    readonly previousHash: string | null,
    readonly currentHash: string,
    readonly allowListed: boolean
  ) {
    super(
      `Contract WASM hash changed from ${previousHash ?? '(unknown)'} to ${currentHash}` +
        (allowListed ? '' : ', which is not in INDEXER_WASM_ALLOW_LIST') +
        '. Indexing is halted; see docs/operations.md#wasm-upgrade.'
    );
    this.name = 'WasmUpgradeError';
  }
}

/** Thrown when too many known events in one page were rejected. */
export class RejectionRateError extends Error {
  constructor(
    readonly rejected: number,
    readonly known: number,
    readonly maxRate: number
  ) {
    super(
      `${rejected} of ${known} known events in the page were rejected ` +
        `(> ${maxRate}); the cursor was not advanced. See docs/operations.md#rejection-rate.`
    );
    this.name = 'RejectionRateError';
  }
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

export type DbErrorClass = 'deterministic' | 'transient' | 'fatal';

/**
 * SQLSTATE table. Anything not listed is treated as `transient`: an unknown
 * failure is retried rather than halting the indexer.
 */
const DB_ERROR_CLASSES: Record<string, DbErrorClass> = {
  // Data exceptions: the event contradicts the read model. Retrying is futile.
  '22001': 'deterministic', // string_data_right_truncation
  '22003': 'deterministic', // numeric_value_out_of_range
  '22007': 'deterministic', // invalid_datetime_format
  '22008': 'deterministic', // datetime_field_overflow
  '22012': 'deterministic', // division_by_zero
  '22021': 'deterministic', // character_not_in_repertoire
  '22P02': 'deterministic', // invalid_text_representation
  '22P05': 'deterministic', // untranslatable_character
  // Integrity constraint violations: same event, same failure.
  '23502': 'deterministic', // not_null_violation
  '23503': 'deterministic', // foreign_key_violation
  '23505': 'deterministic', // unique_violation
  '23514': 'deterministic', // check_violation
  '23P01': 'deterministic', // exclusion_violation
  // Transient: retry the page immediately.
  '40001': 'transient', // serialization_failure
  '40P01': 'transient', // deadlock_detected
  '57P01': 'transient', // admin_shutdown
  '57P02': 'transient', // crash_shutdown
  '57P03': 'transient', // cannot_connect_now
  '53300': 'transient', // too_many_connections
  // Fatal: retrying cannot help; an operator must intervene.
  '28P01': 'fatal', // invalid_password
  '28000': 'fatal', // invalid_authorization_specification
  '3D000': 'fatal', // invalid_catalog_name
  '42P01': 'fatal', // undefined_table
  '42703': 'fatal', // undefined_column
  '42501': 'fatal', // insufficient_privilege
};

/** SQLSTATE classes that are always transient (connection exceptions). */
const TRANSIENT_CLASSES = ['08'];

/**
 * Classify a Postgres error by SQLSTATE. `deterministic` errors are the event's
 * fault (reject it), `transient` ones are retried, `fatal` ones halt indexing.
 */
export function classifyDbError(err: unknown): DbErrorClass {
  const code = (err as { code?: unknown })?.code;
  if (typeof code !== 'string') return 'transient';
  const known = DB_ERROR_CLASSES[code];
  if (known) return known;
  if (TRANSIENT_CLASSES.some((prefix) => code.startsWith(prefix))) return 'transient';
  return 'transient';
}

/**
 * Postgres errors that are deterministic for a given event: data exceptions
 * (class 22, e.g. out of range) and constraint violations (class 23).
 * Retrying would fail forever, so the event is rejected instead.
 */
export function isDeterministicDbError(err: unknown): boolean {
  return classifyDbError(err) === 'deterministic';
}

/** Thrown when the database reports an error that retrying cannot fix. */
export class FatalDbError extends Error {
  constructor(
    readonly code: string,
    readonly cause: unknown
  ) {
    super(
      `Fatal database error ${code}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        'Indexing is halted; see docs/operations.md#fatal-database-error.'
    );
    this.name = 'FatalDbError';
  }
}

/** Immediate retries for transient database errors before falling back to tick backoff. */
export const DB_RETRY_ATTEMPTS = 3;
export const DB_RETRY_BASE_MS = 25;

/** Small jitter so concurrent indexers don't retry in lockstep. */
function retryJitter(attempt: number): number {
  return Math.floor(Math.random() * DB_RETRY_BASE_MS * attempt);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient database errors up to `DB_RETRY_ATTEMPTS` times
 * with small jitter. Fatal errors are wrapped in a FatalDbError; deterministic
 * and unknown errors are rethrown unchanged.
 */
export async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const kind = classifyDbError(err);
      if (kind === 'fatal') {
        throw new FatalDbError((err as { code: string }).code, err);
      }
      if (kind !== 'transient' || attempt >= DB_RETRY_ATTEMPTS) throw err;
      const delay = retryJitter(attempt + 1);
      logger.warn('Transient database error; retrying page', {
        code: (err as { code?: string }).code,
        attempt: attempt + 1,
        delayMs: delay,
      });
      if (delay > 0) await sleep(delay);
    }
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
  return withDbRetry(() => processPageOnce(db, contractId, page));
}

async function processPageOnce(db: Db, contractId: string, page: GetEventsResult): Promise<PageResult> {
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

/**
 * Rejection-rate circuit breaker: a page where more than `maxRejectionRate` of
 * the known (non-duplicate) events were rejected means the event schema probably
 * changed, so the page is rolled back and the cursor stays put.
 */
export function assertRejectionRate(
  result: PageResult,
  config: Pick<IndexerConfig, 'maxRejectionRate' | 'minRejectionSample'>
): void {
  const maxRate = config.maxRejectionRate ?? 0.5;
  if (maxRate >= 1) return;
  const known = result.applied + result.rejected;
  if (known < (config.minRejectionSample ?? 1)) return;
  if (result.rejected / known > maxRate) {
    throw new RejectionRateError(result.rejected, known, maxRate);
  }
}

/**
 * Compare the contract's current WASM hash with the stored one. A change is
 * persisted in `indexer_state`; when the policy is `halt` (or the new hash is
 * not allow-listed) a WasmUpgradeError is thrown so the cursor does not move.
 */
export async function checkWasmHash(deps: IndexerDependencies): Promise<void> {
  const { wasmHash, lastModifiedLedger } = await deps.rpc.getContractInstance(deps.config.contractId);
  if (!wasmHash) return;

  const state = await readState(deps.db);
  const previous = state[STATE.wasmHash] ?? null;
  if (previous === wasmHash) return;

  const allowList = (deps.config.wasmAllowList ?? []).map((hash) => hash.toLowerCase());
  const allowListed = allowList.length === 0 || allowList.includes(wasmHash.toLowerCase());
  const policy = deps.config.onWasmUpgrade ?? 'halt';
  const upgrade = {
    previousHash: previous,
    currentHash: wasmHash,
    allowListed,
    lastModifiedLedger,
    at: new Date().toISOString(),
  };

  await writeState(deps.db, {
    [STATE.wasmHash]: wasmHash,
    [STATE.wasmUpgrade]: JSON.stringify(upgrade),
  });

  if (previous === null) {
    logger.info('Recorded contract WASM hash', { wasmHash, allowListed });
    return;
  }

  logger.warn('Contract WASM hash changed', upgrade);
  if (policy === 'halt' || !allowListed) {
    const err = new WasmUpgradeError(previous, wasmHash, allowListed);
    await writeState(deps.db, { [STATE.status]: 'wasm_upgrade', [STATE.lastError]: err.message });
    throw err;
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

  const result = await processPage(deps.db, deps.config.contractId, page);
  assertRejectionRate(result, deps.config);
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
      await withDbRetry(() => checkWasmHash(deps));
      for (let page = 0; page < maxPages && !stopped; page++) {
        const { events } = await pollOnce(deps);
        if (events < deps.config.pageLimit) break; // caught up
      }
      failures = 0;
    } catch (err) {
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof FatalDbError) {
        stopped = true;
        logger.error('Indexer halted: fatal database error', { error: message, code: err.code });
        await writeState(deps.db, { [STATE.status]: 'fatal_db_error', [STATE.lastError]: message }).catch(
          () => undefined
        );
        return;
      }
      if (err instanceof RetentionGapError) {
        logger.error('Indexer halted: retention gap', { error: message });
      } else if (err instanceof WasmUpgradeError) {
        logger.error('Indexer halted: contract WASM upgrade', { error: message });
      } else if (err instanceof RejectionRateError) {
        logger.error('Indexer halted: rejection rate too high', { error: message });
        await writeState(deps.db, { [STATE.status]: 'rejection_rate', [STATE.lastError]: message }).catch(
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
