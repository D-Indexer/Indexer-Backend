import type { Pool } from 'pg';
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

export type FolderServiceDeps = {
  db: Pool;
};

export type FolderService = {
  getFolderByAddress(owner: string): Promise<Folder | null>;
  getFolderByName(name: string): Promise<Folder | null>;
};

export function createFolderService({ db }: FolderServiceDeps): FolderService {
  async function getFolderByAddress(owner: string): Promise<Folder | null> {
    const { rows } = await db.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE owner = $1`, [owner]);
    return rows[0] ? mapFolder(rows[0]) : null;
  }

  async function getFolderByName(name: string): Promise<Folder | null> {
    const { rows } = await db.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE name = $1`, [name]);
    return rows[0] ? mapFolder(rows[0]) : null;
  }

  return { getFolderByAddress, getFolderByName };
}