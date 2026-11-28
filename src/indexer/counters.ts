import type { Queryable } from '../db/types';
import type { DecodedEvent } from './decode';

/**
 * Derived counters maintained by the indexer.
 *
 * `updateCounters` runs inside the page transaction, from `applyEvent`, BEFORE
 * the read model is mutated, so it can see the previous state of the entity
 * the event touches. `applyEvent` only runs for events whose row was newly
 * inserted into `contract_events` (`storeEvent` returns early on duplicates),
 * so replaying a page or rewinding the cursor never counts an event twice. If
 * the event is rejected, the savepoint rollback also undoes its counter changes.
 */
export async function updateCounters(db: Queryable, event: DecodedEvent): Promise<void> {
  switch (event.topic) {
    case 'port_mint':
    case 'tmpl_set': {
      const current = await currentPortfolioTemplate(db, event.owner);
      if (event.topic === 'port_mint') {
        // A first mint adds a portfolio; a re-mint over an existing one may move it.
        await moveTemplateUsage(db, current, event.templateId);
      } else if (current !== null) {
        // tmpl_set re-points an already-minted portfolio; without one it only
        // changes the folder's selection, which isn't a portfolio using the template.
        await moveTemplateUsage(db, current, event.templateId);
      }
      return;
    }
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
