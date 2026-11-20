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

/**
 * Hot SQL queries exported as named constants so query-plan regression tests
 * can run EXPLAIN against exactly the production SQL.
 */
export const FOLDER_BY_OWNER_QUERY = `SELECT ${COLUMNS} FROM folders WHERE owner = $1`;
export const FOLDER_BY_NAME_QUERY = `SELECT ${COLUMNS} FROM folders WHERE name = $1`;
export const FOLDER_BY_TEMPLATE_ID_QUERY = `SELECT ${COLUMNS} FROM folders WHERE template_id = $1`;
export const FOLDER_BY_LEDGER_QUERY = `SELECT ${COLUMNS} FROM folders WHERE ledger = $1`;

export async function getFolderByAddress(owner: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(FOLDER_BY_OWNER_QUERY, [owner]);
  return rows[0] ? mapFolder(rows[0]) : null;
}

export async function getFolderByName(name: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(FOLDER_BY_NAME_QUERY, [name]);
  return rows[0] ? mapFolder(rows[0]) : null;
}

export async function getFolderByTemplateId(templateId: number): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(FOLDER_BY_TEMPLATE_ID_QUERY, [templateId]);
  return rows[0] ? mapFolder(rows[0]) : null;
}

export async function getFolderByLedger(ledger: number): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(FOLDER_BY_LEDGER_QUERY, [ledger]);
  return rows[0] ? mapFolder(rows[0]) : null;
}