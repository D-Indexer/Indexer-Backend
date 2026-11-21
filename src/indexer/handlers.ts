import type { PoolClient } from 'pg';
import type { DecodedEvent } from './decode';

export type Queryable = Pick<PoolClient, 'query'>;

/** Append one row to the admin history. Idempotent on the event id. */
async function recordAdminChange(
  db: Queryable,
  eventId: string,
  ledger: number,
  action: 'init' | 'add' | 'remove',
  actor: string | null,
  target: string,
  at: Date
): Promise<void> {
  await db.query(
    `INSERT INTO admin_changes (event_id, ledger, action, actor, target, at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING`,
    [eventId, ledger, action, actor, target, at]
  );
}

/**
 * Apply one decoded contract event to the read model. Runs inside the page
 * transaction (see processPage); `at` is the ledger close time of the event.
 * Each event id is applied at most once, so handlers don't need to be
 * idempotent on their own, but they are written as upserts anyway so a manual
 * cursor rewind (docs/operations.md) converges to the same state.
 */
export async function applyEvent(
  db: Queryable,
  event: DecodedEvent,
  at: Date,
  eventId: string,
  ledger: number
): Promise<void> {
  switch (event.topic) {
    case 'init':
      await recordAdminChange(db, eventId, ledger, 'init', null, event.admin, at);
      await db.query(
        `INSERT INTO admins (address, added_at, added_by, added_event_id) VALUES ($1, $2, NULL, $3)
         ON CONFLICT (address) DO NOTHING`,
        [event.admin, at, eventId]
      );
      return;

    case 'adm_add':
      await recordAdminChange(db, eventId, ledger, 'add', event.admin, event.newAdmin, at);
      await db.query(
        `INSERT INTO admins (address, added_at, added_by, added_event_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (address) DO NOTHING`,
        [event.newAdmin, at, event.admin, eventId]
      );
      return;

    case 'adm_rm':
      await recordAdminChange(db, eventId, ledger, 'remove', event.admin, event.target, at);
      await db.query('DELETE FROM admins WHERE address = $1', [event.target]);
      return;

    case 'folder_cl':
      await db.query(
        `INSERT INTO folders (owner, name, claimed_at, updated_at) VALUES ($1, $2, $3, $3)
         ON CONFLICT (owner) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
        [event.owner, event.folderName, at]
      );
      return;

    case 'tmpl_reg':
      await db.query(
        `INSERT INTO templates (id, metadata_uri, creator, registered_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET metadata_uri = EXCLUDED.metadata_uri, creator = EXCLUDED.creator`,
        [event.templateId, event.metadataUri, event.creator, at]
      );
      return;

    case 'tmpl_set':
      // set_user_template also re-points an already-minted portfolio.
      await db.query('UPDATE folders SET template_id = $2, updated_at = $3 WHERE owner = $1', [
        event.owner,
        event.templateId,
        at,
      ]);
      await db.query('UPDATE portfolios SET template_id = $2, updated_at = $3 WHERE owner = $1', [
        event.owner,
        event.templateId,
        at,
      ]);
      return;

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
      return;

    case 'port_upd':
      await db.query('UPDATE portfolios SET ipfs_cid = $2, updated_at = $3 WHERE owner = $1', [
        event.owner,
        event.ipfsCid,
        at,
      ]);
      return;
  }
}
