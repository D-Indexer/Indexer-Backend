import type { Pool, PoolClient } from 'pg';
import type { RawEvent } from './rpc';

/**
 * Storage boundary for raw event XDR.
 *
 * The RPC returns topics and values as base64 XDR. `contract_events` stores the
 * decoded bytes (`topic_xdr BYTEA[]`, `value_xdr BYTEA`), which is ~25% smaller
 * than the base64 text and keeps TOAST pressure down on the largest table.
 * Conversion happens only here: everything that exposes raw XDR (snapshots,
 * APIs, ad-hoc SQL via `translate(encode(value_xdr, 'base64'), E'\n', '')`)
 * still speaks base64 (Postgres' encode() inserts a newline every 76 chars).
 */

/** Raised when the RPC hands us XDR that is not canonical base64. */
export class XdrEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XdrEncodingError';
  }
}

/**
 * True when `b64` is canonical, padded base64, i.e. decoding and re-encoding
 * gives back the same string. `Buffer.from(s, 'base64')` silently skips
 * invalid characters, so this check is what makes the conversion lossless.
 */
export function isCanonicalBase64(b64: string): boolean {
  return Buffer.from(b64, 'base64').toString('base64') === b64;
}

/** base64 XDR -> bytes. Throws XdrEncodingError unless the input is canonical base64. */
export function xdrToBytes(b64: string): Buffer {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.toString('base64') !== b64) {
    throw new XdrEncodingError(`raw XDR is not canonical base64 (${b64.length} chars)`);
  }
  return bytes;
}

/** bytes -> base64 XDR, the representation every API exposes. */
export function bytesToXdr(bytes: Buffer): string {
  return bytes.toString('base64');
}

/**
 * Bytes to store for a raw XDR string that is not canonical base64. Such an
 * event is always rejected; its text is kept verbatim (UTF-8) so nothing is
 * lost, and `convert_from(value_xdr, 'UTF8')` recovers it. The batched
 * migration in src/db/xdrByteaMigration.ts applies the same rule.
 */
function fallbackBytes(raw: string): Buffer {
  return Buffer.from(raw, 'utf8');
}

export type StoredXdr = {
  topicXdr: Buffer[];
  valueXdr: Buffer;
  /** Set when some XDR was not canonical base64 and was stored verbatim instead. */
  error: string | null;
};

/** Convert an RPC event's base64 topic/value XDR to the bytes stored in Postgres. */
export function toStoredXdr(event: Pick<RawEvent, 'topic' | 'value'>): StoredXdr {
  let error: string | null = null;
  const convert = (raw: string, what: string): Buffer => {
    try {
      return xdrToBytes(raw);
    } catch (err) {
      if (!(err instanceof XdrEncodingError)) throw err;
      error ??= `${what}: ${err.message}`;
      return fallbackBytes(raw);
    }
  };
  const topicXdr = event.topic.map((t, i) => convert(t, `topic[${i}]`));
  const valueXdr = convert(event.value, 'value');
  return { topicXdr, valueXdr, error };
}

/** Columns of `contract_events` as node-postgres returns them. */
export type ContractEventRow = {
  id: string;
  ledger: number;
  ledger_closed_at: Date;
  tx_hash: string;
  contract_id: string;
  topic: string;
  topic_xdr: Buffer[];
  value_xdr: Buffer;
  data: unknown;
  status: 'applied' | 'ignored' | 'rejected';
  error: string | null;
};

/** Rebuild the RPC event (base64 XDR) from a stored row. */
export function rowToRawEvent(
  row: Pick<
    ContractEventRow,
    'id' | 'ledger' | 'ledger_closed_at' | 'tx_hash' | 'contract_id' | 'topic_xdr' | 'value_xdr'
  >
): RawEvent {
  return {
    type: 'contract',
    ledger: row.ledger,
    ledgerClosedAt: row.ledger_closed_at.toISOString().replace(/\.000Z$/, 'Z'),
    contractId: row.contract_id,
    id: row.id,
    txHash: row.tx_hash,
    topic: row.topic_xdr.map(bytesToXdr),
    value: bytesToXdr(row.value_xdr),
  };
}

export type InsertContractEvent = {
  event: RawEvent;
  contractId: string;
  topic: string;
  stored: StoredXdr;
  data: unknown;
  status: 'applied' | 'ignored' | 'rejected';
  error: string | null;
};

/**
 * Insert one event, ignoring duplicates. Returns false when the event was
 * already stored. contract_events is partitioned on ledger with primary key
 * (ledger, id); the ledger is derived from the id, so the primary key conflict
 * is exactly "this event id is already stored".
 */
export async function insertContractEvent(
  db: Pick<PoolClient | Pool, 'query'>,
  row: InsertContractEvent
): Promise<boolean> {
  const inserted = await db.query(
    `INSERT INTO contract_events
       (id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7::bytea[], $8::bytea, $9, $10, $11)
     ON CONFLICT (ledger, id) DO NOTHING
     RETURNING id`,
    [
      row.event.id,
      row.event.ledger,
      row.event.ledgerClosedAt,
      row.event.txHash,
      row.contractId,
      row.topic,
      row.stored.topicXdr,
      row.stored.valueXdr,
      row.data === null || row.data === undefined ? null : JSON.stringify(row.data),
      row.status,
      row.error,
    ]
  );
  return (inserted.rowCount ?? 0) > 0;
}
