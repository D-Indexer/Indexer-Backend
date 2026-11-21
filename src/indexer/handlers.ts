import type { PoolClient } from 'pg';
import type { DecodedEvent } from './decode';

export type Queryable = Pick<PoolClient, 'query'>;

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
  network?: string,
  contractId?: string
): Promise<void> {
  switch (event.topic) {
    case 'init':
      await db.query(
        network
          ? 'INSERT INTO admins (network, contract_id, address, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT (network, address) DO NOTHING'
          : 'INSERT INTO admins (address, added_at) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING',
        network ? [network, contractId, event.admin, at] : [event.admin, at]
      );
      return;

    case 'adm_add':
      await db.query(
        network
          ? 'INSERT INTO admins (network, contract_id, address, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT (network, address) DO NOTHING'
          : 'INSERT INTO admins (address, added_at) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING',
        network ? [network, contractId, event.newAdmin, at] : [event.newAdmin, at]
      );
      return;

    case 'adm_rm':
      await db.query(
        network ? 'DELETE FROM admins WHERE network = $1 AND address = $2' : 'DELETE FROM admins WHERE address = $1',
        network ? [network, event.target] : [event.target]
      );
      return;

    case 'folder_cl':
      await db.query(
        network
          ? `INSERT INTO folders (network, contract_id, owner, name, claimed_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)
             ON CONFLICT (network, owner) DO UPDATE SET name = EXCLUDED.name, contract_id = EXCLUDED.contract_id, updated_at = EXCLUDED.updated_at`
          : `INSERT INTO folders (owner, name, claimed_at, updated_at) VALUES ($1, $2, $3, $3)
             ON CONFLICT (owner) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
        network ? [network, contractId, event.owner, event.folderName, at] : [event.owner, event.folderName, at]
      );
      return;

    case 'tmpl_reg':
      await db.query(
        network
          ? `INSERT INTO templates (network, contract_id, id, metadata_uri, creator, registered_at) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (network, id) DO UPDATE
               SET metadata_uri = EXCLUDED.metadata_uri, creator = EXCLUDED.creator,
                   contract_id = EXCLUDED.contract_id`
          : `INSERT INTO templates (id, metadata_uri, creator, registered_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (id) DO UPDATE
               SET metadata_uri = EXCLUDED.metadata_uri, creator = EXCLUDED.creator`,
        network
          ? [network, contractId, event.templateId, event.metadataUri, event.creator, at]
          : [event.templateId, event.metadataUri, event.creator, at]
      );
      return;

    case 'tmpl_set':
      // set_user_template also re-points an already-minted portfolio.
      if (network) {
        await db.query(
          'UPDATE folders SET template_id = $2, contract_id = $4, updated_at = $3 WHERE network = $1 AND owner = $5',
          [network, event.templateId, at, contractId, event.owner]
        );
        await db.query(
          'UPDATE portfolios SET template_id = $2, contract_id = $4, updated_at = $3 WHERE network = $1 AND owner = $5',
          [network, event.templateId, at, contractId, event.owner]
        );
      } else {
        await db.query('UPDATE folders SET template_id = $2, updated_at = $3 WHERE owner = $1', [
          event.owner, event.templateId, at,
        ]);
        await db.query('UPDATE portfolios SET template_id = $2, updated_at = $3 WHERE owner = $1', [
          event.owner, event.templateId, at,
        ]);
      }
      return;

    case 'port_mint':
      // mint_portfolio also sets the owner's selected template.
      await db.query(
        network
          ? `INSERT INTO portfolios (network, contract_id, owner, template_id, ipfs_cid, minted_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $6)
             ON CONFLICT (network, owner) DO UPDATE
               SET template_id = EXCLUDED.template_id, ipfs_cid = EXCLUDED.ipfs_cid,
                   contract_id = EXCLUDED.contract_id, updated_at = EXCLUDED.updated_at`
          : `INSERT INTO portfolios (owner, template_id, ipfs_cid, minted_at, updated_at)
             VALUES ($1, $2, $3, $4, $4)
             ON CONFLICT (owner) DO UPDATE
               SET template_id = EXCLUDED.template_id, ipfs_cid = EXCLUDED.ipfs_cid,
                   updated_at = EXCLUDED.updated_at`,
        network
          ? [network, contractId, event.owner, event.templateId, event.ipfsCid, at]
          : [event.owner, event.templateId, event.ipfsCid, at]
      );
      await db.query(
        network
          ? 'UPDATE folders SET template_id = $2, contract_id = $4, updated_at = $3 WHERE network = $1 AND owner = $5'
          : 'UPDATE folders SET template_id = $2, updated_at = $3 WHERE owner = $1',
        network
          ? [network, event.templateId, at, contractId, event.owner]
          : [event.owner, event.templateId, at]
      );
      return;

    case 'port_upd':
      await db.query(
        network
          ? 'UPDATE portfolios SET ipfs_cid = $2, contract_id = $4, updated_at = $3 WHERE network = $1 AND owner = $5'
          : 'UPDATE portfolios SET ipfs_cid = $2, updated_at = $3 WHERE owner = $1',
        network
          ? [network, event.ipfsCid, at, contractId, event.owner]
          : [event.owner, event.ipfsCid, at]
      );
      return;
  }
}
