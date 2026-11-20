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

export class LedgerRangeError extends Error {
  status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'LedgerRangeError';
  }
}

async function getIndexedLedgerRange(): Promise<{ earliest: number | null; latest: number | null }> {
  const { rows } = await pool.query<{ earliest: string | null; latest: string | null }>(
    `SELECT MIN(from_ledger) AS earliest, MAX(to_ledger) AS latest FROM folders_history`
  );
  const row = rows[0];
  return {
    earliest: row && row.earliest !== null ? Number(row.earliest) : null,
    latest: row && row.latest !== null ? Number(row.latest) : null,
  };
}

async function validateLedger(ledger: number): Promise<void> {
  if (!Number.isInteger(ledger) || ledger < 0) {
    throw new LedgerRangeError(`Invalid ledger: ${ledger}`);
  }
  const { earliest, latest } = await getIndexedLedgerRange();
  if (earliest === null || latest === null) {
    throw new LedgerRangeError('No indexed ledgers available');
  }
  if (ledger < earliest) {
    throw new LedgerRangeError(
      `Ledger ${ledger} is before the earliest indexed ledger (${earliest})`
    );
  }
  if (ledger > latest) {
    throw new LedgerRangeError(
      `Ledger ${ledger} is after the last indexed ledger (${latest})`
    );
  }
}

export async function getFolderByAddress(owner: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE owner = $1`, [owner]);
  return rows[0] ? mapFolder(rows[0]) : null;
}

export async function getFolderByName(name: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>(`SELECT ${COLUMNS} FROM folders WHERE name = $1`, [name]);
  return rows[0] ? mapFolder(rows[0]) : null;
}

export async function getFolderByAddressAtLedger(owner: string, ledger: number): Promise<Folder | null> {
  await validateLedger(ledger);
  const { rows } = await pool.query<FolderRow>(
    `SELECT ${COLUMNS} FROM folders_history
     WHERE owner = $1 AND from_ledger <= $2 AND to_ledger > $2
     ORDER BY from_ledger DESC
     LIMIT 1`,
    [owner, ledger]
  );
  return rows[0] ? mapFolder(rows[0]) : null;
}

export async function getFolderByNameAtLedger(name: string, ledger: number): Promise<Folder | null> {
  await validateLedger(ledger);
  const { rows } = await pool.query<FolderRow>(
    `SELECT ${COLUMNS} FROM folders_history
     WHERE name = $1 AND from_ledger <= $2 AND to_ledger > $2
     ORDER BY from_ledger DESC
     LIMIT 1`,
    [name, ledger]
  );
  return rows[0] ? mapFolder(rows[0]) : null;
}