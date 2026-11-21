import pool from '../db/client';
import { Folder } from '../types';
import { CursorOrder, ListCursor, encodeCursor } from '../http/cursor';

type FolderRow = {
  owner: string;
  name: string;
  template_id: string | null;
  claimed_at: Date;
  updated_at: Date;
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

export async function getFolderByAddress(owner: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE owner = $1`, [owner]);
  return rows[0] ? mapFolder(rows[0]) : null;
}

/** Resolve many owners with one query; missing owners map to null. */
export async function getFoldersByAddresses(owners: string[]): Promise<Record<string, Folder | null>> {
  const result: Record<string, Folder | null> = {};
  for (const owner of owners) result[owner] = null;
  if (owners.length === 0) return result;

  const { rows } = await pool.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE owner = ANY($1::text[])`, [
    owners,
  ]);
  for (const row of rows) result[row.owner] = mapFolder(row);
  return result;
}

export async function getFolderByName(name: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE name = $1`, [name]);
  return rows[0] ? mapFolder(rows[0]) : null;
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
