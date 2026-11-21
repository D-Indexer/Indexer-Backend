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

export async function getFolderByAddress(owner: string, network?: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(
    network ? `SELECT ${COLUMNS} FROM folders WHERE network = $1 AND owner = $2` : `SELECT ${COLUMNS} FROM folders WHERE owner = $1`,
    network ? [network, owner] : [owner]
  );
  return rows[0] ? mapFolder(rows[0]) : null;
}

export async function getFolderByName(name: string, network?: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(
    network ? `SELECT ${COLUMNS} FROM folders WHERE network = $1 AND name = $2` : `SELECT ${COLUMNS} FROM folders WHERE name = $1`,
    network ? [network, name] : [name]
  );
  return rows[0] ? mapFolder(rows[0]) : null;
}
