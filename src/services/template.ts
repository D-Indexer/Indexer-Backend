import type { Queryable } from '../db/types';
import type { Template, TemplatePortfolio } from '../types';
import { isoMicros, toPage, type Page, type PageRequest } from '../http/pagination';

type TemplateRow = {
  id: string; // BIGINT comes back as a string
  metadata_uri: string;
  creator: string | null;
  registered_at: Date;
  usage_count: string;
};

type TemplatePortfolioRow = {
  owner: string;
  template_id: string;
  ipfs_cid: string;
  minted_at: Date;
  updated_at: Date;
  cursor_ts: string;
};

export type TemplateSort = 'id' | 'popular';

export function mapTemplate(row: TemplateRow): Template {
  return {
    id: Number(row.id),
    metadataUri: row.metadata_uri,
    creator: row.creator,
    registeredAt: row.registered_at,
    usageCount: Number(row.usage_count),
  };
}

function mapTemplatePortfolio(row: TemplatePortfolioRow): TemplatePortfolio {
  return {
    owner: row.owner,
    templateId: Number(row.template_id),
    ipfsCid: row.ipfs_cid,
    mintedAt: row.minted_at,
    updatedAt: row.updated_at,
  };
}

/** usageCount comes from the indexer-maintained template_usage counter, never an aggregate. */
export const TEMPLATE_SELECT = `SELECT t.id, t.metadata_uri, t.creator, t.registered_at,
       COALESCE(u.portfolio_count, 0) AS usage_count
  FROM templates t
  LEFT JOIN template_usage u ON u.template_id = t.id`;

// Hot SQL paths, exported as named constants so query-plan regression tests
// can run EXPLAIN against the exact statements used in production.
export const LIST_TEMPLATES_SQL = `${TEMPLATE_SELECT} ORDER BY t.id`;
export const LIST_POPULAR_TEMPLATES_SQL = `${TEMPLATE_SELECT}
 ORDER BY COALESCE(u.portfolio_count, 0) DESC, t.id`;
export const GET_TEMPLATE_SQL = `${TEMPLATE_SELECT} WHERE t.id = $1`;

const TEMPLATE_PORTFOLIO_COLUMNS = `owner, template_id, ipfs_cid, minted_at, updated_at,
       ${isoMicros('updated_at')} AS cursor_ts`;

/** Newest-updated first; owner breaks ties so the order is total and pages never overlap. */
export const LIST_TEMPLATE_PORTFOLIOS_SQL = `SELECT ${TEMPLATE_PORTFOLIO_COLUMNS}
  FROM portfolios
 WHERE template_id = $1
 ORDER BY updated_at DESC, owner DESC
 LIMIT $2`;

export const LIST_TEMPLATE_PORTFOLIOS_AFTER_SQL = `SELECT ${TEMPLATE_PORTFOLIO_COLUMNS}
  FROM portfolios
 WHERE template_id = $1 AND (updated_at, owner) < ($3::timestamptz, $4)
 ORDER BY updated_at DESC, owner DESC
 LIMIT $2`;

export async function listTemplates(db: Queryable, sort: TemplateSort = 'id'): Promise<Template[]> {
  const sql = sort === 'popular' ? LIST_POPULAR_TEMPLATES_SQL : LIST_TEMPLATES_SQL;
  const { rows } = await db.query<TemplateRow>(sql);
  return rows.map(mapTemplate);
}

export async function getTemplate(db: Queryable, id: number): Promise<Template | null> {
  const { rows } = await db.query<TemplateRow>(GET_TEMPLATE_SQL, [id]);
  const row = rows[0];
  return row ? mapTemplate(row) : null;
}

/** Portfolios currently using `templateId`, keyset paginated by (updated_at DESC, owner DESC). */
export async function listTemplatePortfolios(
  db: Queryable,
  templateId: number,
  page: PageRequest
): Promise<Page<TemplatePortfolio>> {
  const fetch = page.limit + 1;
  const { rows } = page.after
    ? await db.query<TemplatePortfolioRow>(LIST_TEMPLATE_PORTFOLIOS_AFTER_SQL, [
        templateId,
        fetch,
        ...page.after,
      ])
    : await db.query<TemplatePortfolioRow>(LIST_TEMPLATE_PORTFOLIOS_SQL, [templateId, fetch]);
  return toPage(rows, page.limit, mapTemplatePortfolio, (row) => [row.cursor_ts, row.owner]);
}

// ---------------------------------------------------------------------------
// Creators
// ---------------------------------------------------------------------------

type CreatorTemplateRow = TemplateRow & { cursor_ts: string };

/**
 * A creator's templates, oldest registration first; id breaks ties so the
 * order is total. Backed by idx_templates_creator_registered. Templates from
 * contract versions whose tmpl_reg had no creator are stored with
 * creator = NULL and never match.
 */
const CREATOR_TEMPLATE_SELECT = `SELECT t.id, t.metadata_uri, t.creator, t.registered_at,
       COALESCE(u.portfolio_count, 0) AS usage_count,
       ${isoMicros('t.registered_at')} AS cursor_ts
  FROM templates t
  LEFT JOIN template_usage u ON u.template_id = t.id`;

export const LIST_CREATOR_TEMPLATES_SQL = `${CREATOR_TEMPLATE_SELECT}
 WHERE t.creator = $1
 ORDER BY t.registered_at, t.id
 LIMIT $2`;

export const LIST_CREATOR_TEMPLATES_AFTER_SQL = `${CREATOR_TEMPLATE_SELECT}
 WHERE t.creator = $1 AND (t.registered_at, t.id) > ($3::timestamptz, $4::bigint)
 ORDER BY t.registered_at, t.id
 LIMIT $2`;

export const CREATOR_STATS_SQL = `SELECT COUNT(*) AS template_count,
       COALESCE(SUM(u.portfolio_count), 0) AS total_usage
  FROM templates t
  LEFT JOIN template_usage u ON u.template_id = t.id
 WHERE t.creator = $1`;

export interface CreatorStats {
  address: string;
  templateCount: number;
  /** Sum of usageCount over the creator's templates. */
  totalUsage: number;
}

export async function listTemplatesByCreator(
  db: Queryable,
  creator: string,
  page: PageRequest
): Promise<Page<Template>> {
  const fetch = page.limit + 1;
  const { rows } = page.after
    ? await db.query<CreatorTemplateRow>(LIST_CREATOR_TEMPLATES_AFTER_SQL, [creator, fetch, ...page.after])
    : await db.query<CreatorTemplateRow>(LIST_CREATOR_TEMPLATES_SQL, [creator, fetch]);
  return toPage(rows, page.limit, mapTemplate, (row) => [row.cursor_ts, row.id]);
}

/** Aggregate stats for a creator. Unknown creators get zeros rather than a 404. */
export async function getCreatorStats(db: Queryable, creator: string): Promise<CreatorStats> {
  const { rows } = await db.query<{ template_count: string; total_usage: string }>(CREATOR_STATS_SQL, [
    creator,
  ]);
  const row = rows[0];
  return {
    address: creator,
    templateCount: Number(row?.template_count ?? 0),
    totalUsage: Number(row?.total_usage ?? 0),
  };
}
