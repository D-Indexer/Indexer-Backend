import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * Entity-level change feed for read-model synchronisation.
 *
 * The feed is derived from applied contract events (`contract_events`) in
 * commit order (ledger, tx, event id). Each event is mapped to one or more
 * entity-level upserts/deletes for folders, portfolios and templates.
 *
 * Cursors are opaque and stable: they are the base64 encoding of the last
 * consumed event id. A cursor that is malformed, or that points to an event
 * older than the retained window, results in a `CursorExpiredError` so the
 * caller can respond with `410 Gone` and instruct a full resync.
 */

export type ChangeEntity = 'folder' | 'portfolio' | 'template';
export type ChangeOp = 'upsert' | 'delete';

export interface EntityChange {
  entity: ChangeEntity;
  key: string;
  op: ChangeOp;
  data: Record<string, unknown> | null;
  cursor: string;
}

export interface GetChangesOptions {
  since?: string | null;
  limit?: number;
}

export interface GetChangesResult {
  changes: EntityChange[];
  nextCursor: string | null;
}

export class CursorExpiredError extends Error {
  constructor(message = 'Cursor expired or invalid; resync from the beginning') {
    super(message);
    this.name = 'CursorExpiredError';
  }
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface ContractEventRow {
  id: string;
  ledger: number | string;
  tx_index: number | string;
  event_index: number | string;
  contract_id: string;
  topic: string | null;
  event_type: string | null;
  payload: unknown;
}

function encodeCursor(eventId: string): string {
  return Buffer.from(String(eventId), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded) {
      throw new Error('empty');
    }
    return decoded;
  } catch {
    throw new CursorExpiredError('Malformed cursor; resync from the beginning');
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }
  const n = Math.floor(limit);
  if (n <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(n, MAX_LIMIT);
}

function parsePayload(payload: unknown): Record<string, unknown> | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  return null;
}

function pickKey(data: Record<string, unknown> | null, fallback: string): string {
  if (!data) {
    return fallback;
  }
  const candidates = ['id', 'key', 'address', 'slug', 'name'];
  for (const c of candidates) {
    const v = data[c];
    if (typeof v === 'string' && v.length > 0) {
      return v;
    }
    if (typeof v === 'number') {
      return String(v);
    }
  }
  return fallback;
}

/**
 * Map a single applied contract event to zero or more entity-level changes.
 * The mapping is intentionally tolerant of payload shape so that it works
 * across folder, portfolio and template events.
 */
function mapEventToChanges(row: ContractEventRow, cursor: string): EntityChange[] {
  const data = parsePayload(row.payload);
  const type = (row.event_type ?? row.topic ?? '').toLowerCase();

  const changes: EntityChange[] = [];

  const isDelete = type.includes('delete') || type.includes('remove') || type.includes('archive');
  const op: ChangeOp = isDelete ? 'delete' : 'upsert';

  const fallbackKey = `${row.contract_id}:${row.id}`;

  if (type.includes('folder')) {
    changes.push({
      entity: 'folder',
      key: pickKey(data, fallbackKey),
      op,
      data: isDelete ? null : data,
      cursor,
    });
  } else if (type.includes('portfolio')) {
    changes.push({
      entity: 'portfolio',
      key: pickKey(data, fallbackKey),
      op,
      data: isDelete ? null : data,
      cursor,
    });
  } else if (type.includes('template')) {
    changes.push({
      entity: 'template',
      key: pickKey(data, fallbackKey),
      op,
      data: isDelete ? null : data,
      cursor,
    });
  } else if (data) {
    // Fall back to inspecting the payload for an entity discriminator.
    const entityField = data.entity ?? data.kind ?? data.type;
    if (typeof entityField === 'string') {
      const normalized = entityField.toLowerCase();
      if (normalized === 'folder' || normalized === 'portfolio' || normalized === 'template') {
        changes.push({
          entity: normalized as ChangeEntity,
          key: pickKey(data, fallbackKey),
          op,
          data: isDelete ? null : data,
          cursor,
        });
      }
    }
  }

  return changes;
}

/**
 * Fetch a page of entity-level changes in commit order.
 *
 * @throws CursorExpiredError when `since` is malformed or older than the
 *   retained window.
 */
export async function getChanges(
  db: NodePgDatabase<any>,
  options: GetChangesOptions = {},
): Promise<GetChangesResult> {
  const limit = clampLimit(options.limit);

  let sinceEventId: string | null = null;
  if (options.since !== undefined && options.since !== null && options.since !== '') {
    sinceEventId = decodeCursor(options.since);
  }

  // Determine the ordering position of the `since` cursor. If the referenced
  // event no longer exists (pruned / outside retained window), the cursor is
  // considered expired.
  let sinceLedger: number | null = null;
  let sinceTx: number | null = null;
  let sinceEventIndex: number | null = null;

  if (sinceEventId !== null) {
    const cursorRows = await db.execute(sql`
      SELECT ledger, tx_index, event_index
      FROM contract_events
      WHERE id = ${sinceEventId}
      LIMIT 1
    `);
    const rows = (cursorRows as unknown as { rows?: unknown[] }).rows ?? (cursorRows as unknown as unknown[]);
    const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
    if (!first) {
      throw new CursorExpiredError('Cursor references an event outside the retained window; resync from the beginning');
    }
    sinceLedger = Number(first.ledger);
    sinceTx = Number(first.tx_index);
    sinceEventIndex = Number(first.event_index);
  }

  // Fetch one extra row to detect whether more pages exist.
  const fetchLimit = limit + 1;

  const result = await db.execute(sql`
    SELECT id, ledger, tx_index, event_index, contract_id, topic, event_type, payload
    FROM contract_events
    WHERE ${
      sinceEventId === null
        ? sql`TRUE`
        : sql`(
            ledger > ${sinceLedger}
            OR (ledger = ${sinceLedger} AND tx_index > ${sinceTx})
            OR (ledger = ${sinceLedger} AND tx_index = ${sinceTx} AND event_index > ${sinceEventIndex})
          )`
    }
    ORDER BY ledger ASC, tx_index ASC, event_index ASC, id ASC
    LIMIT ${fetchLimit}
  `);

  const rawRows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  const rows = (Array.isArray(rawRows) ? rawRows : []) as ContractEventRow[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const changes: EntityChange[] = [];
  let lastCursor: string | null = options.since ?? null;

  for (const row of pageRows) {
    const cursor = encodeCursor(String(row.id));
    lastCursor = cursor;
    const mapped = mapEventToChanges(row, cursor);
    for (const change of mapped) {
      changes.push(change);
    }
  }

  return {
    changes,
    nextCursor: hasMore ? lastCursor : null,
  };
}

export default getChanges;