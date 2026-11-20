import pool from '../db/client';
import { Folder } from '../types';

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
 * Look up the moderation state for a folder by its key (name).
 * Returns null when no moderation record exists.
 */
export async function getFolderModeration(name: string): Promise<ModerationInfo | null> {
  const { rows } = await pool.query<ModerationRow>(
    `SELECT state FROM moderation WHERE entity_type = $1 AND key = $2`,
    ['folder', name],
  );
  if (!rows[0]) {
    return null;
  }
  return {
    hidden: rows[0].state === 'hidden',
    state: rows[0].state,
  };
}

function withModeration(folder: Folder, moderation: ModerationInfo | null): FolderWithModeration {
  if (moderation && moderation.hidden) {
    return { ...folder, moderation: { hidden: true, state: moderation.state } };
  }
  return folder;
}

export async function getFolderByAddress(owner: string): Promise<FolderWithModeration | null> {
  const { rows } = await pool.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE owner = $1`, [owner]);
  if (!rows[0]) {
    return null;
  }
  const folder = mapFolder(rows[0]);
  const moderation = await getFolderModeration(folder.name);
  return withModeration(folder, moderation);
}

export async function getFolderByName(name: string): Promise<FolderWithModeration | null> {
  const { rows } = await pool.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE name = $1`, [name]);
  if (!rows[0]) {
    return null;
  }
  const folder = mapFolder(rows[0]);
  const moderation = await getFolderModeration(folder.name);
  return withModeration(folder, moderation);
}