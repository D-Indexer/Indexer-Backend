import type { Queryable } from '../db/types';

export interface StatCounts {
  foldersClaimed: number;
  portfoliosMinted: number;
  portfolioUpdates: number;
  templatesRegistered: number;
}

export interface DailyStat extends StatCounts {
  /** UTC calendar day (YYYY-MM-DD) of the ledger close times counted. */
  day: string;
}

type CountsRow = {
  folders_claimed: string;
  portfolios_minted: string;
  portfolio_updates: string;
  templates_registered: string;
};

function mapCounts(row: CountsRow | undefined): StatCounts {
  return {
    foldersClaimed: Number(row?.folders_claimed ?? 0),
    portfoliosMinted: Number(row?.portfolios_minted ?? 0),
    portfolioUpdates: Number(row?.portfolio_updates ?? 0),
    templatesRegistered: Number(row?.templates_registered ?? 0),
  };
}

/** One row per day with activity, so this stays small (bounded by the chain's age in days). */
export const STATS_TOTALS_SQL = `SELECT COALESCE(SUM(folders_claimed), 0) AS folders_claimed,
       COALESCE(SUM(portfolios_minted), 0) AS portfolios_minted,
       COALESCE(SUM(portfolio_updates), 0) AS portfolio_updates,
       COALESCE(SUM(templates_registered), 0) AS templates_registered
  FROM daily_stats`;

/** Every day in [from, to], zero-filled where nothing happened. */
export const STATS_DAILY_SQL = `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       COALESCE(s.folders_claimed, 0) AS folders_claimed,
       COALESCE(s.portfolios_minted, 0) AS portfolios_minted,
       COALESCE(s.portfolio_updates, 0) AS portfolio_updates,
       COALESCE(s.templates_registered, 0) AS templates_registered
  FROM generate_series($1::date, $2::date, interval '1 day') AS d(day)
  LEFT JOIN daily_stats s ON s.day = d.day::date
 ORDER BY d.day`;

export async function getTotals(db: Queryable): Promise<StatCounts> {
  const { rows } = await db.query<CountsRow>(STATS_TOTALS_SQL);
  return mapCounts(rows[0]);
}

/** `from` and `to` are inclusive YYYY-MM-DD UTC days. */
export async function getDaily(db: Queryable, from: string, to: string): Promise<DailyStat[]> {
  const { rows } = await db.query<CountsRow & { day: string }>(STATS_DAILY_SQL, [from, to]);
  return rows.map((row) => ({ day: row.day, ...mapCounts(row) }));
}
