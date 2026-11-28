import type { Queryable } from '../db/types';
import type { DecodedEvent } from './decode';

/**
 * Derived counters maintained by the indexer: template_usage (portfolios per
 * template) and daily_stats (activity per UTC day of ledger close).
 *
 * `updateCounters` runs inside the page transaction, from `applyEvent`, BEFORE
 * the read model is mutated, so it can see the previous state of the entity
 * the event touches. `applyEvent` only runs for events whose row was newly
 * inserted into `contract_events` (`storeEvent` returns early on duplicates),
 * so replaying a page or rewinding the cursor never counts an event twice. If
 * the event is rejected, the savepoint rollback also undoes its counter changes.
 */
export async function updateCounters(db: Queryable, event: DecodedEvent, at: Date): Promise<void> {
  switch (event.topic) {
    case 'folder_cl': {
      const { rows } = await db.query('SELECT 1 FROM folders WHERE owner = $1', [event.owner]);
      if (rows.length === 0) await bumpDailyStat(db, at, 'folders_claimed');
      return;
    }
    case 'tmpl_reg': {
      // Re-registration (a metadata update) is not a new template.
      const { rows } = await db.query('SELECT 1 FROM templates WHERE id = $1', [event.templateId]);
      if (rows.length === 0) await bumpDailyStat(db, at, 'templates_registered');
      return;
    }
    case 'port_mint':
    case 'tmpl_set': {
      const current = await currentPortfolioTemplate(db, event.owner);
      if (event.topic === 'port_mint') {
        if (current === null) await bumpDailyStat(db, at, 'portfolios_minted');
        // A first mint adds a portfolio; a re-mint over an existing one may move it.
        await moveTemplateUsage(db, current, event.templateId);
      } else if (current !== null) {
        // tmpl_set re-points an already-minted portfolio; without one it only
        // changes the folder's selection, which isn't a portfolio using the template.
        await moveTemplateUsage(db, current, event.templateId);
      }
      return;
    }
    case 'port_upd':
      await bumpDailyStat(db, at, 'portfolio_updates');
      return;
    default:
      return;
  }
}

async function currentPortfolioTemplate(db: Queryable, owner: string): Promise<number | null> {
  // FOR UPDATE: the row is about to be rewritten by the handler in this transaction.
  const { rows } = await db.query<{ template_id: string }>(
    'SELECT template_id FROM portfolios WHERE owner = $1 FOR UPDATE',
    [owner]
  );
  const row = rows[0];
  return row ? Number(row.template_id) : null;
}

/**
 * Move one portfolio from template `from` to template `to` in `template_usage`.
 * Either side may be null (new portfolio / no destination). Decrements clamp at
 * zero rather than failing: a CHECK violation here would reject a valid
 * on-chain event over a derived counter.
 */
export async function moveTemplateUsage(
  db: Queryable,
  from: number | null,
  to: number | null
): Promise<void> {
  if (from === to) return;
  if (from !== null) {
    await db.query(
      `UPDATE template_usage SET portfolio_count = GREATEST(portfolio_count - 1, 0)
       WHERE template_id = $1`,
      [from]
    );
  }
  if (to !== null) {
    await db.query(
      `INSERT INTO template_usage (template_id, portfolio_count) VALUES ($1, 1)
       ON CONFLICT (template_id) DO UPDATE
         SET portfolio_count = template_usage.portfolio_count + 1`,
      [to]
    );
  }
}

// ---------------------------------------------------------------------------
// Daily stats
// ---------------------------------------------------------------------------

export const DAILY_STAT_COLUMNS = [
  'folders_claimed',
  'portfolios_minted',
  'portfolio_updates',
  'templates_registered',
] as const;
export type DailyStatColumn = (typeof DAILY_STAT_COLUMNS)[number];

/** UTC calendar day of a ledger close time, as YYYY-MM-DD. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

async function bumpDailyStat(db: Queryable, at: Date, column: DailyStatColumn): Promise<void> {
  // `column` is one of the fixed literals above, never user input.
  await db.query(
    `INSERT INTO daily_stats (day, ${column}) VALUES ($1, 1)
     ON CONFLICT (day) DO UPDATE SET ${column} = daily_stats.${column} + 1`,
    [utcDay(at)]
  );
}

/**
 * Recompute daily_stats from contract_events using the same definitions the
 * incremental path uses:
 *
 * - folders_claimed / portfolios_minted / templates_registered count the FIRST
 *   applied folder_cl per owner, port_mint per owner and tmpl_reg per template
 *   id (the incremental path counts an event when the read-model row didn't
 *   exist yet, and only these events create those rows);
 * - portfolio_updates counts every applied port_upd.
 *
 * Only `applied` events count: rejected events had their counter changes
 * rolled back with the rest of their savepoint.
 */
export const REBUILD_DAILY_STATS_SQL = `
WITH firsts AS (
  SELECT DISTINCT ON (topic, entity) topic, ledger_closed_at
    FROM (
      SELECT topic, ledger, id, ledger_closed_at,
             CASE topic WHEN 'tmpl_reg' THEN data->>'templateId' ELSE data->>'owner' END AS entity
        FROM contract_events
       WHERE status = 'applied' AND topic IN ('folder_cl', 'port_mint', 'tmpl_reg')
    ) e
   ORDER BY topic, entity, ledger, id
),
counted AS (
  SELECT topic, ledger_closed_at FROM firsts
  UNION ALL
  SELECT topic, ledger_closed_at FROM contract_events WHERE status = 'applied' AND topic = 'port_upd'
)
INSERT INTO daily_stats (day, folders_claimed, portfolios_minted, portfolio_updates, templates_registered)
SELECT (ledger_closed_at AT TIME ZONE 'UTC')::date,
       COUNT(*) FILTER (WHERE topic = 'folder_cl'),
       COUNT(*) FILTER (WHERE topic = 'port_mint'),
       COUNT(*) FILTER (WHERE topic = 'port_upd'),
       COUNT(*) FILTER (WHERE topic = 'tmpl_reg')
  FROM counted
 GROUP BY 1`;

/**
 * Replace daily_stats with values recomputed from contract_events, in one
 * transaction. `db` must be a dedicated connection (it runs BEGIN/COMMIT).
 *
 * The EXCLUSIVE lock blocks indexer increments (but not API reads) for the
 * duration. An indexer page that already incremented holds a conflicting
 * lock, so the rebuild waits for it to commit and then counts its events; a
 * page that commits after the rebuild applies its increments on top. Either
 * way each event is counted exactly once.
 */
export async function rebuildDailyStats(db: Queryable): Promise<{ days: number }> {
  await db.query('BEGIN');
  try {
    await db.query('LOCK TABLE daily_stats IN EXCLUSIVE MODE');
    await db.query('DELETE FROM daily_stats');
    const result = await db.query(REBUILD_DAILY_STATS_SQL);
    await db.query('COMMIT');
    return { days: result.rowCount ?? 0 };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
