import type { Pool } from 'pg';
import { Folder } from '../types';
import { CursorOrder, ListCursor, encodeCursor } from '../http/cursor';

type FolderRow = {
  owner: string;
  name: string;
  template_id: string | null;
  claimed_at: Date;
  updated_at: Date;
};

type ModerationRow = {
  state: string;
};

export type ModerationInfo = {
  hidden: boolean;
  state?: string;
};

export type FolderWithModeration = Folder & {
  moderation?: ModerationInfo;
};

function mapFolder(row: FolderRow): Folder {
  return {
    owner: row.owner,
    name: row.name,
    templateId: row.template_id === null ? null : Number(row.template_id),
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = 'owner, name, template_id, claimed_at, updated_at';

/**
 * Hot SQL queries exported as named constants so query-plan regression tests
 * can run EXPLAIN against exactly the production SQL.
 */
export const FOLDER_BY_OWNER_QUERY = `SELECT ${COLUMNS} FROM folders WHERE owner = $1`;
export const FOLDER_BY_NAME_QUERY = `SELECT ${COLUMNS} FROM folders WHERE name = $1`;
export const FOLDER_BY_TEMPLATE_ID_QUERY = `SELECT ${COLUMNS} FROM folders WHERE template_id = $1`;
export const FOLDER_BY_LEDGER_QUERY = `SELECT ${COLUMNS} FROM folders WHERE ledger = $1`;

export async function getFolderByAddress(owner: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE owner = $1`, [owner]);
  const row = rows[0];
  return row ? mapFolder(row) : null;
}

export async function getFolderByName(name: string): Promise<FolderWithModeration | null> {
  const { rows } = await pool.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE name = $1`, [name]);
  const row = rows[0];
  return row ? mapFolder(row) : null;
}

export type FolderPage = {
  items: Folder[];
  /** Cursor for the next page, or null when this is the last page. */
  nextCursor: string | null;
};

/**
 * Keyset page of folders ordered by `claimed_at` (ties broken by owner, so the
 * ordering is total). Hidden folders are excluded. The cursor is a strict
 * `(claimed_at, owner) > (cursor.at, cursor.owner)` comparison, which stays
 * stable when rows are inserted concurrently.
 */
export async function listFolders(options: {
  order: CursorOrder;
  limit: number;
  cursor?: ListCursor;
}): Promise<FolderPage> {
  const { order, limit, cursor } = options;
  const params: unknown[] = [];
  const where: string[] = ['NOT EXISTS (SELECT 1 FROM hidden_folders h WHERE h.owner = f.owner)'];

  if (cursor) {
    params.push(cursor.at, cursor.owner);
    where.push(`(f.${order}, f.owner) > ($1::timestamptz, $2)`);
  }
  params.push(limit + 1);

  const { rows } = await pool.query<FolderRow>(
    `SELECT ${COLUMNS} FROM folders f
      WHERE ${where.join(' AND ')}
      ORDER BY f.${order} ASC, f.owner ASC
      LIMIT $${params.length}`,
    params
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({ order, at: last.claimed_at.toISOString(), owner: last.owner })
      : null;

  return { items: page.map(mapFolder), nextCursor };
}

export type NameAvailability = {
  name: string;
  normalized: string;
  valid: boolean;
  available: boolean;
  reason?: string;
  indexedLedger: number | null;
};

export async function checkNameAvailability(name: string): Promise<NameAvailability> {
  const normalized = name.trim().toLowerCase();

  // Validate against contract rules
  if (normalized.length === 0) {
    return {
      name,
      normalized,
      valid: false,
      available: false,
      reason: 'Folder name is required',
      indexedLedger: null,
    };
  }
  if (normalized.length > FOLDER_NAME_MAX_LENGTH) {
    return {
      name,
      normalized,
      valid: false,
      available: false,
      reason: `Folder name must be at most ${FOLDER_NAME_MAX_LENGTH} characters`,
      indexedLedger: null,
    };
  }
  if (!FOLDER_NAME_REGEX.test(normalized)) {
    return {
      name,
      normalized,
      valid: false,
      available: false,
      reason: 'Folder name contains unsupported characters',
      indexedLedger: null,
    };
  }
  if (FOLDER_NAME_RESERVED.has(normalized)) {
    return {
      name,
      normalized,
      valid: false,
      available: false,
      reason: 'Folder name is reserved',
      indexedLedger: null,
    };
  }

  // Check availability in DB and fetch indexer cursor in parallel
  const [folderResult, stateResult] = await Promise.all([
    pool.query('SELECT 1 FROM folders WHERE lower(name) = $1 LIMIT 1', [normalized]),
    pool.query<{ value: string }>(`SELECT value FROM indexer_state WHERE key = 'lastLedger'`),
  ]);

  const available = folderResult.rowCount === 0;
  const indexedLedger = stateResult.rows[0] ? Number(stateResult.rows[0].value) : null;

  return { name, normalized, valid: true, available, indexedLedger };
}
