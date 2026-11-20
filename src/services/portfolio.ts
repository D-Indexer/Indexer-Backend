import pool from '../db/client';
import { Portfolio } from '../types';

type PortfolioRow = {
  owner: string;
  template_id: string;
  ipfs_cid: string;
  minted_at: Date;
  updated_at: Date;
};

type ModerationRow = {
  state: 'hidden' | 'flagged';
  reason: string | null;
  actor: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ModerationInfo = {
  hidden: boolean;
  state?: 'hidden' | 'flagged';
  reason?: string | null;
  actor?: string | null;
  updatedAt?: Date;
};

export type PortfolioWithModeration = Portfolio & {
  moderation?: ModerationInfo;
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

async function getModeration(entityType: string, key: string): Promise<ModerationRow | null> {
  const { rows } = await pool.query<ModerationRow>(
    `SELECT state, reason, actor, created_at, updated_at
       FROM moderation
      WHERE entity_type = $1 AND entity_key = $2
      LIMIT 1`,
    [entityType, key]
  );
  return rows[0] ?? null;
}

function toModerationInfo(row: ModerationRow | null): ModerationInfo | undefined {
  if (!row) return undefined;
  return {
    hidden: row.state === 'hidden',
    state: row.state,
    reason: row.reason,
    actor: row.actor,
    updatedAt: row.updated_at,
  };
}

export async function getPortfolio(owner: string): Promise<PortfolioWithModeration | null> {
  const { rows } = await pool.query<PortfolioRow>(
    'SELECT owner, template_id, ipfs_cid, minted_at, updated_at FROM portfolios WHERE owner = $1',
    [owner]
  );
  if (!rows[0]) return null;

  const portfolio = mapPortfolio(rows[0]);
  const moderation = await getModeration('portfolio', owner);
  const info = toModerationInfo(moderation);
  return info ? { ...portfolio, moderation: info } : portfolio;
}

export async function isPortfolioHidden(owner: string): Promise<boolean> {
  const moderation = await getModeration('portfolio', owner);
  return moderation?.state === 'hidden';
}

export type ListPortfoliosOptions = {
  limit?: number;
  offset?: number;
};

export async function listPortfolios(
  options: ListPortfoliosOptions = {}
): Promise<Portfolio[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const offset = Math.max(0, options.offset ?? 0);

  const { rows } = await pool.query<PortfolioRow>(
    `SELECT p.owner, p.template_id, p.ipfs_cid, p.minted_at, p.updated_at
       FROM portfolios p
       LEFT JOIN moderation m
         ON m.entity_type = 'portfolio' AND m.entity_key = p.owner
      WHERE m.state IS NULL OR m.state <> 'hidden'
      ORDER BY p.minted_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.map(mapPortfolio);
}

export async function countPortfolios(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM portfolios p
       LEFT JOIN moderation m
         ON m.entity_type = 'portfolio' AND m.entity_key = p.owner
      WHERE m.state IS NULL OR m.state <> 'hidden'`
  );
  return Number(rows[0]?.count ?? 0);
}