import pool from '../db/client';
import { Folder } from '../types';
import { FOLDER_NAME_REGEX, FOLDER_NAME_RESERVED, FOLDER_NAME_MAX_LENGTH } from '../validation/schemas';

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

export async function getFolderByName(name: string): Promise<Folder | null> {
  // Case-insensitive lookup (contract names are compared case-insensitively)
  const { rows } = await pool.query<FolderRow>(
    `SELECT ${COLUMNS} FROM folders WHERE lower(name) = lower($1)`,
    [name]
  );
  return rows[0] ? mapFolder(rows[0]) : null;
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
