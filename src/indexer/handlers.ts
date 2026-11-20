import type { PoolClient } from 'pg';
import type { DecodedEvent } from './decode';

export type Queryable = Pick<PoolClient, 'query'>;

/**
 * Feature flag for portfolio ownership transfers (see docs/architecture.md).
 * While disabled, `port_transfer` events are ignored so the read model keeps
 * behaving exactly as before transfers were introduced.
 */
export const TRANSFERS_ENABLED = process.env.PORTFOLIO_TRANSFERS_ENABLED === 'true';

/**
 * Apply one decoded contract event to the read model. Runs inside the page
 * transaction (see processPage); `at` is the ledger close time of the event.
 * Each event id is applied at most once, so handlers don't need to be
 * idempotent on their own, but they are written as upserts anyway so a manual
 * cursor rewind (docs/operations.md) converges to the same state.
 */
export async function applyEvent(db: Queryable, event: DecodedEvent, at: Date): Promise<void> {
  switch (event.topic) {
    case 'init':
      await db.query(
        'INSERT INTO admins (address, added_at) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING',
        [event.admin, at]
      );
      return;

    case 'adm_add':
      await db.query(
        'INSERT INTO admins (address, added_at) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING',
        [event.newAdmin, at]
      );
      return;

    case 'adm_rm':
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
      // mint_portfolio also sets the owner's selected template. Portfolios are
      // keyed by token id; owner is an indexed attribute so transfers don't
      // orphan data. The token id is the agreed stable identifier.
      await db.query(
        `INSERT INTO portfolios (token_id, owner, template_id, ipfs_cid, minted_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (token_id) DO UPDATE
           SET owner = EXCLUDED.owner, template_id = EXCLUDED.template_id,
               ipfs_cid = EXCLUDED.ipfs_cid, updated_at = EXCLUDED.updated_at`,
        [event.tokenId, event.owner, event.templateId, event.ipfsCid, at]
      );
      await db.query(
        `INSERT INTO ownership_history (token_id, owner, acquired_at, reason)
         VALUES ($1, $2, $3, 'mint') ON CONFLICT DO NOTHING`,
        [event.tokenId, event.owner, at]
      );
      await db.query('UPDATE folders SET template_id = $2, updated_at = $3 WHERE owner = $1', [
        event.owner,
        event.templateId,
        at,
      ]);
      return;

    case 'port_upd':
      await db.query('UPDATE portfolios SET ipfs_cid = $2, updated_at = $3 WHERE token_id = $1', [
        event.tokenId,
        event.ipfsCid,
        at,
      ]);
      return;

    case 'port_transfer':
      // Ownership transfer: move the owner attribute and record history
      // without deleting any portfolio data. No-op while the feature is off.
      if (!TRANSFERS_ENABLED) return;
      await db.query(
        `UPDATE portfolios SET owner = $2, updated_at = $3 WHERE token_id = $1`,
        [event.tokenId, event.to, at]
      );
      await db.query(
        `INSERT INTO ownership_history (token_id, owner, acquired_at, reason)
         VALUES ($1, $2, $3, 'transfer') ON CONFLICT DO NOTHING`,
        [event.tokenId, event.to, at]
      );
      return;
  }
}
