import pool from '../db/client';
import { Folder } from '../types';

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
