import pool from '../db/client';
import { Portfolio } from '../types';

type PortfolioRow = {
  owner: string;
  template_id: string;
  ipfs_cid: string;
  minted_at: Date;
  updated_at: Date;
};

function mapPortfolio(row: PortfolioRow): Portfolio {
  return {
    owner: row.owner,
    templateId: Number(row.template_id),
    ipfsCid: row.ipfs_cid,
    mintedAt: row.minted_at,
    updatedAt: row.updated_at,
  };
}

export async function getPortfolio(owner: string): Promise<Portfolio | null> {
  const { rows } = await pool.query<PortfolioRow>(
    'SELECT owner, template_id, ipfs_cid, minted_at, updated_at FROM portfolios WHERE owner = $1',
    [owner]
  );
  return rows[0] ? mapPortfolio(rows[0]) : null;
}
