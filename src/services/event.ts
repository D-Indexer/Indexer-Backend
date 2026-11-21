import pool from '../db/client';
import { ContractEvent } from '../types';

type EventRow = {
  id: string;
  ledger: number;
  ledger_closed_at: Date;
  tx_hash: string;
  contract_id: string;
  topic: string;
  topic_xdr: string[];
  value_xdr: string;
  data: Record<string, unknown> | null;
  status: ContractEvent['status'];
  error: string | null;
  indexed_at: Date;
};

export type EventFilters = {
  topic?: string;
  owner?: string;
  status?: ContractEvent['status'];
  fromLedger?: number;
  toLedger?: number;
  limit?: number;
  cursor?: { ledger: number; id: string };
};

export type EventPage = { events: ContractEvent[]; nextCursor: string | null };

const COLUMNS =
  'id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status, error, indexed_at';

function mapEvent(row: EventRow): ContractEvent {
  return {
    id: row.id,
    ledger: row.ledger,
    ledgerClosedAt: row.ledger_closed_at,
    txHash: row.tx_hash,
    contractId: row.contract_id,
    topic: row.topic,
    topicXdr: row.topic_xdr,
    valueXdr: row.value_xdr,
    data: row.data,
    status: row.status,
    error: row.error,
    indexedAt: row.indexed_at,
  };
}

/**
 * Keyset pagination on (ledger, id): the cursor is the last row of the previous
 * page, so rows inserted later never shift or repeat a page.
 */
export async function listEvents(filters: EventFilters): Promise<EventPage> {
  const limit = filters.limit ?? 50;
  const params: unknown[] = [];
  const where: string[] = [];

  if (filters.topic !== undefined) {
    params.push(filters.topic);
    where.push(`topic = $${params.length}`);
  }
  if (filters.owner !== undefined) {
    params.push(filters.owner);
    where.push(`data->>'owner' = $${params.length}`);
  }
  if (filters.status !== undefined) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.fromLedger !== undefined) {
    params.push(filters.fromLedger);
    where.push(`ledger >= $${params.length}`);
  }
  if (filters.toLedger !== undefined) {
    params.push(filters.toLedger);
    where.push(`ledger <= $${params.length}`);
  }
  if (filters.cursor) {
    params.push(filters.cursor.ledger, filters.cursor.id);
    where.push(`(ledger, id) > ($${params.length - 1}, $${params.length})`);
  }

  params.push(limit + 1);
  const sql =
    `SELECT ${COLUMNS} FROM contract_events` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ledger, id LIMIT $${params.length}`;

  const { rows } = await pool.query<EventRow>(sql, params);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    events: page.map(mapEvent),
    nextCursor: hasMore && last ? `${last.ledger}:${last.id}` : null,
  };
}

export async function getEvent(id: string): Promise<ContractEvent | null> {
  const { rows } = await pool.query<EventRow>(`SELECT ${COLUMNS} FROM contract_events WHERE id = $1`, [id]);
  return rows[0] ? mapEvent(rows[0]) : null;
}
