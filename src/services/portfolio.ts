import type { Pool } from 'pg';
import { Portfolio } from '../types';

type PortfolioRow = {
  owner: string;
  template_id: string;
  ipfs_cid: string;
  minted_at: Date;
  updated_at: Date;
};

export const GET_PORTFOLIO_SQL =
  'SELECT owner, template_id, ipfs_cid, minted_at, updated_at FROM portfolios WHERE owner = $1';

function mapPortfolio(row: PortfolioRow): Portfolio {
  return {
    owner: row.owner,
    templateId: Number(row.template_id),
    ipfsCid: row.ipfs_cid,
    mintedAt: row.minted_at,
    updatedAt: row.updated_at,
  };
}

function mapPortfolioVersion(row: PortfolioVersionRow): PortfolioVersion {
  return {
    owner: row.owner,
    version: Number(row.version),
    ipfsCid: row.ipfs_cid,
    templateId: Number(row.template_id),
    eventId: row.event_id,
    at: row.at,
  };
}

function mapPortfolioAtLedger(row: PortfolioAtLedgerRow): PortfolioAtLedger {
  return {
    ...mapPortfolio(row),
    fromLedger: Number(row.from_ledger),
    toLedger: row.to_ledger === null ? null : Number(row.to_ledger),
  };
}

function normaliseLimit(limit?: number): number {
  if (limit === undefined || limit === null || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }
  const n = Math.floor(limit);
  if (n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function encodeVersionCursor(version: number): string {
  return Buffer.from(`v:${version}`, 'utf8').toString('base64url');
}

function decodeVersionCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^v:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return Number(match[1]);
  } catch {
    throw new InvalidLedgerError('Invalid pagination cursor');
  }
}

export async function getPortfolio(owner: string): Promise<Portfolio | null> {
  const { rows } = await pool.query<PortfolioRow>(
    'SELECT owner, template_id, ipfs_cid, minted_at, updated_at FROM portfolios WHERE owner = $1',
    [owner]
  );
  const row = rows[0];
  return row ? mapPortfolio(row) : null;
}