import type { Pool, PoolClient } from 'pg';
import { TransactionBuilder } from '@stellar/stellar-sdk';
import { decodeEvent, decodeTopic, DecodedEvent, EventDecodeError } from './decode';
import { applyEvent } from './handlers';
import {
  EventSource,
  GetEventsParams,
  GetEventsResult,
  GetTransactionResult,
  LedgerRangeError,
  RawEvent,
  RpcError,
} from './rpc';
import { logger } from '../utils/logger';
import { TESTNET_PASSPHRASE } from '../config/env';

/** Network passphrase used to parse transaction envelopes. */
const NETWORK_PASSPHRASE = TESTNET_PASSPHRASE;

/** indexer_state keys. */
export const STATE = {
  cursor: 'cursor',
  startLedger: 'start_ledger',
  lastLedger: 'last_ledger',
  lastSuccessAt: 'last_success_at',
  status: 'status',
  lastError: 'last_error',
  lastGap: 'last_gap',
  activeEndpoint: 'active_endpoint',
  enrichCursor: 'enrichment_cursor',
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
  /** Fetch source account, fee and memo for indexed transactions. Defaults to true. */
  enrichTransactions?: boolean;
  /** Max transactions enriched per tick. Defaults to 50. */
  enrichBatchSize?: number;
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
 * Decompose an RPC event id (a TOID: `ledger << 32 | txOrder << 12 | opOrder`,
 * followed by `-<eventIndex>`) into its ordering columns. Returns nulls when the
 * id doesn't have the expected shape, so the row is still stored.
 */
export function parseEventId(id: string): {
  toid: string | null;
  txOrder: number | null;
  opOrder: number | null;
  eventIndex: number | null;
} {
  const match = /^(\d+)-(\d+)$/.exec(id);
  if (!match) return { toid: null, txOrder: null, opOrder: null, eventIndex: null };
  const toid = BigInt(match[1]);
  const eventIndex = Number(match[2]);
  if (!Number.isSafeInteger(eventIndex)) return { toid: null, txOrder: null, opOrder: null, eventIndex: null };
  return {
    toid: toid.toString(),
    txOrder: Number((toid >> 12n) & 0xfffffn),
    opOrder: Number(toid & 0xfffn),
    eventIndex,
  };
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
  const { toid, txOrder, opOrder, eventIndex } = parseEventId(event.id);
  const inserted = await client.query(
    `INSERT INTO contract_events
       (id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status, error,
        toid, tx_order, op_order, event_index)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
      toid,
      txOrder,
      opOrder,
      eventIndex,
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
  if (deps.rpc.activeEndpoint) {
    await writeState(deps.db, { [STATE.activeEndpoint]: deps.rpc.activeEndpoint });
  }
  if (page.events.length > 0) {
    logger.info('Indexed events', { ...result, lastLedger: page.events[page.events.length - 1].ledger });
  }
  return { events: page.events.length, result };
}

/** A transaction row decoded from an RPC getTransaction result. */
export type EnrichedTransaction = {
  hash: string;
  ledger: number | null;
  sourceAccount: string | null;
  feeCharged: string | null;
  maxFee: string | null;
  memoType: string | null;
  memo: string | null;
  successful: boolean | null;
  feeBump: boolean;
  muxedSource: string | null;
  envelopeXdr: string | null;
};

/**
 * Decode a getTransaction result into the columns of the `transactions` table.
 * Handles fee-bump envelopes (the inner transaction is the one that ran) and
 * muxed sources (the underlying G... account is stored, the M... address kept
 * alongside). Throws when the envelope XDR can't be parsed.
 */
export function decodeTransaction(hash: string, tx: GetTransactionResult): EnrichedTransaction {
  const base: EnrichedTransaction = {
    hash,
    ledger: tx.ledger ?? null,
    sourceAccount: null,
    feeCharged: null,
    maxFee: null,
    memoType: null,
    memo: null,
    successful: tx.status === 'SUCCESS' ? true : tx.status === 'FAILED' ? false : null,
    feeBump: false,
    muxedSource: null,
    envelopeXdr: tx.envelopeXdr ?? null,
  };
  if (!tx.envelopeXdr) return base;

  const envelope = TransactionBuilder.fromXDR(tx.envelopeXdr, NETWORK_PASSPHRASE);
  const feeBump = 'innerTransaction' in envelope;
  const inner = feeBump ? envelope.innerTransaction : envelope;
  const source = inner.source;
  const muxed = source && typeof source === 'object' && 'accountId' in source ? source : null;

  return {
    ...base,
    sourceAccount: muxed ? muxed.accountId() : (source ?? null),
    feeCharged: feeBump ? envelope.fee().toString() : null,
    maxFee: inner.fee ? inner.fee.toString() : null,
    memoType: inner.memo?.type ?? null,
    memo: inner.memo?.value != null ? String(inner.memo.value) : null,
    feeBump,
    muxedSource: muxed ? muxed.address() : null,
  };
}

/**
 * Enrich up to `enrichBatchSize` transactions whose hash appears in
 * contract_events but has no `transactions` row yet. The enrichment cursor is
 * the last tx_hash processed, so a restart resumes where it stopped.
 */
export async function enrichOnce(deps: IndexerDependencies): Promise<number> {
  const { db, rpc } = deps;
  if (!rpc.getTransaction) return 0;
  const limit = deps.config.enrichBatchSize ?? 50;
  const state = await readState(db);
  const cursor = state[STATE.enrichCursor] ?? '';

  const { rows } = await db.query<{ tx_hash: string }>(
    `SELECT DISTINCT e.tx_hash
       FROM contract_events e
       LEFT JOIN transactions t ON t.hash = e.tx_hash
      WHERE t.hash IS NULL AND e.tx_hash > $1
      ORDER BY e.tx_hash
      LIMIT $2`,
    [cursor, limit]
  );
  if (rows.length === 0) return 0;

  let enriched = 0;
  for (const { tx_hash: hash } of rows) {
    try {
      const tx = await rpc.getTransaction(hash);
      const row = decodeTransaction(hash, tx);
      await db.query(
        `INSERT INTO transactions
           (hash, ledger, source_account, fee_charged, max_fee, memo_type, memo, successful,
            fee_bump, muxed_source, envelope_xdr, enriched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (hash) DO UPDATE SET
           ledger = EXCLUDED.ledger,
           source_account = EXCLUDED.source_account,
           fee_charged = EXCLUDED.fee_charged,
           max_fee = EXCLUDED.max_fee,
           memo_type = EXCLUDED.memo_type,
           memo = EXCLUDED.memo,
           successful = EXCLUDED.successful,
           fee_bump = EXCLUDED.fee_bump,
           muxed_source = EXCLUDED.muxed_source,
           envelope_xdr = EXCLUDED.envelope_xdr,
           enriched_at = NOW()`,
        [
          row.hash,
          row.ledger,
          row.sourceAccount,
          row.feeCharged,
          row.maxFee,
          row.memoType,
          row.memo,
          row.successful,
          row.feeBump,
          row.muxedSource,
          row.envelopeXdr,
        ]
      );
      enriched++;
    } catch (err) {
      // A transaction outside the RPC's retention window can never be fetched;
      // record it as unknown so it is not retried forever.
      if (!(err instanceof RpcError) || err.retryable) throw err;
      logger.warn('Could not enrich transaction', {
        hash,
        error: err instanceof Error ? err.message : String(err),
      });
      await db.query(
        `INSERT INTO transactions (hash, enriched_at) VALUES ($1, NOW())
         ON CONFLICT (hash) DO NOTHING`,
        [hash]
      );
    }
    await writeState(db, { [STATE.enrichCursor]: hash });
  }

  logger.info('Enriched transactions', { enriched, scanned: rows.length });
  return enriched;
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
    // Enrichment is best-effort: a failure here never affects event indexing.
    if (deps.config.enrichTransactions !== false && !stopped) {
      try {
        await enrichOnce(deps);
      } catch (err) {
        logger.warn('Transaction enrichment failed', {
          error: err instanceof Error ? err.message : String(err),
        });
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
