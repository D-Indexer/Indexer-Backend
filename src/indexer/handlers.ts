import type { PoolClient } from 'pg';
import type { DecodedEvent } from './decode';

export type Queryable = Pick<PoolClient, 'query'>;

/**
 * Outcome of applying one event. `orphaned` means the event updates a row that
 * does not exist yet (the indexer started partway through history, or the
 * parent event is later in the same page); it is stored and re-applied when the
 * parent row arrives.
 */
export type ApplyOutcome = 'applied' | 'orphaned';

/**
 * Apply one decoded contract event to the read model. Runs inside the page
 * transaction (see processPage); `at` is the ledger close time of the event.
 * Each event id is applied at most once, so handlers don't need to be
 * idempotent on their own, but they are written as upserts anyway so a manual
 * cursor rewind (docs/operations.md) converges to the same state.
 */
export async function applyEvent(db: Queryable, event: DecodedEvent, at: Date): Promise<ApplyOutcome> {
  switch (event.topic) {
    case 'init':
      await db.query(
        'INSERT INTO admins (address, added_at) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING',
        [event.admin, at]
      );
      return 'applied';

    case 'adm_add':
      await db.query(
        'INSERT INTO admins (address, added_at) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING',
        [event.newAdmin, at]
      );
      return 'applied';

    case 'adm_rm':
      await db.query('DELETE FROM admins WHERE address = $1', [event.target]);
      return 'applied';

    case 'folder_cl':
      // A name belongs to exactly one owner: drop it from any previous owner
      // (and record the move) before the claiming owner takes it.
      await db.query(
        `INSERT INTO folder_name_history (name, owner, claimed_at)
         SELECT name, owner, claimed_at FROM folders WHERE name = $1 AND owner <> $2
         ON CONFLICT (name, owner, claimed_at) DO NOTHING`,
        [event.folderName, event.owner]
      );
      await db.query('DELETE FROM folders WHERE name = $1 AND owner <> $2', [
        event.folderName,
        event.owner,
      ]);
      await db.query(
        `INSERT INTO folders (owner, name, claimed_at, updated_at) VALUES ($1, $2, $3, $3)
         ON CONFLICT (owner) DO UPDATE
           SET name = EXCLUDED.name, claimed_at = EXCLUDED.claimed_at,
               updated_at = EXCLUDED.updated_at`,
        [event.owner, event.folderName, at]
      );
      return 'applied';

    case 'tmpl_reg':
      await db.query(
        `INSERT INTO templates (id, metadata_uri, creator, registered_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET metadata_uri = EXCLUDED.metadata_uri, creator = EXCLUDED.creator`,
        [event.templateId, event.metadataUri, event.creator, at]
      );
      return 'applied';

    case 'tmpl_set': {
      // set_user_template also re-points an already-minted portfolio.
      const folders = await db.query(
        'UPDATE folders SET template_id = $2, updated_at = $3 WHERE owner = $1',
        [event.owner, event.templateId, at]
      );
      const portfolios = await db.query(
        'UPDATE portfolios SET template_id = $2, updated_at = $3 WHERE owner = $1',
        [event.owner, event.templateId, at]
      );
      // Orphaned only when the owner has no row at all to update.
      return (folders.rowCount ?? 0) + (portfolios.rowCount ?? 0) === 0 ? 'orphaned' : 'applied';
    }

    case 'port_mint':
      // mint_portfolio also sets the owner's selected template.
      await db.query(
        `INSERT INTO portfolios (owner, template_id, ipfs_cid, minted_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (owner) DO UPDATE
           SET template_id = EXCLUDED.template_id, ipfs_cid = EXCLUDED.ipfs_cid,
               updated_at = EXCLUDED.updated_at`,
        [event.owner, event.templateId, event.ipfsCid, at]
      );
      await db.query('UPDATE folders SET template_id = $2, updated_at = $3 WHERE owner = $1', [
        event.owner,
        event.templateId,
        at,
      ]);
      return 'applied';

    case 'port_upd': {
      const updated = await db.query(
        'UPDATE portfolios SET ipfs_cid = $2, updated_at = $3 WHERE owner = $1',
        [event.owner, event.ipfsCid, at]
      );
      return (updated.rowCount ?? 0) === 0 ? 'orphaned' : 'applied';
    }
  }
}

/**
 * Re-apply orphaned events for `owner` now that a parent row exists. Only
 * events newer than the row's `updated_at` are applied, so a stale orphan never
 * overwrites fresher state. Returns the number of events re-applied.
 */
export async function reapplyOrphans(db: Queryable, owner: string): Promise<number> {
  const { rows } = await db.query<{ id: string; data: DecodedEvent; ledger_closed_at: Date }>(
    `SELECT id, data, ledger_closed_at FROM contract_events
      WHERE status = 'orphaned' AND data->>'owner' = $1
      ORDER BY ledger, id`,
    [owner]
  );

  let reapplied = 0;
  for (const row of rows) {
    const at = new Date(row.ledger_closed_at);
    // Skip orphans older than the row they would update: the parent event
    // already carries newer state.
    const { rows: current } = await db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM portfolios WHERE owner = $1',
      [owner]
    );
    if (current.length > 0 && new Date(current[0].updated_at) > at) continue;

    const outcome = await applyEvent(db, row.data, at);
    if (outcome !== 'applied') continue;
    await db.query("UPDATE contract_events SET status = 'applied', error = NULL WHERE id = $1", [
      row.id,
    ]);
    reapplied++;
  }
  return reapplied;
}
