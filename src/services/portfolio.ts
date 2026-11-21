import pool from '../db/client';
import { getEnv } from '../config/env';
import { NftMetadata, Portfolio } from '../types';
import { resolveUrl } from './ipfs';

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

/** Resolve many owners with one query; missing owners map to null. */
export async function getPortfoliosByAddresses(owners: string[]): Promise<Record<string, Portfolio | null>> {
  const result: Record<string, Portfolio | null> = {};
  for (const owner of owners) result[owner] = null;
  if (owners.length === 0) return result;

  const { rows } = await pool.query<PortfolioRow>(
    'SELECT owner, template_id, ipfs_cid, minted_at, updated_at FROM portfolios WHERE owner = ANY($1::text[])',
    [owners]
  );
  for (const row of rows) result[row.owner] = mapPortfolio(row);
  return result;
}

/**
 * Build the ERC-721-style metadata document for a minted portfolio. The token
 * id is the owner address (the contract keys portfolios by owner). Returns null
 * when the token is unknown, so callers never serve a partial document.
 */
export async function getPortfolioMetadata(tokenId: string): Promise<NftMetadata | null> {
  const portfolio = await getPortfolio(tokenId);
  if (!portfolio) return null;

  const env = getEnv();
  const frontend = env.FRONTEND_BASE_URL.replace(/\/$/, '');

  return {
    name: `D-Indexer Portfolio #${portfolio.owner}`,
    description: `Portfolio NFT owned by ${portfolio.owner}, built from template ${portfolio.templateId}.`,
    image: await resolveUrl(portfolio.ipfsCid),
    external_url: `${frontend}/portfolio/${portfolio.owner}`,
    attributes: [
      { trait_type: 'Owner', value: portfolio.owner },
      { trait_type: 'Template', value: portfolio.templateId },
      { trait_type: 'IPFS CID', value: portfolio.ipfsCid },
      { trait_type: 'Minted At', value: portfolio.mintedAt.toISOString() },
      { trait_type: 'Metadata Version', value: 1 },
    ],
  };
}
