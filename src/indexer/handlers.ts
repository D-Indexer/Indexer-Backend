import type { PoolClient } from 'pg';
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import type { DecodedEvent } from './decode';
import { normaliseCid } from '../services/cid';

export type Queryable = Pick<PoolClient, 'query'>;

export interface NormalisedCid {
  /** Canonical CIDv1 base32 form, or null when the input isn't a parseable CID. */
  cid: string | null;
  /** The original string exactly as stored on-chain. */
  raw: string;
  valid: boolean;
}

/**
 * Normalise an arbitrary CID string to canonical CIDv1 base32. CIDv0 (`Qm...`)
 * and other multibase encodings of the same content collapse to one form so
 * equality checks across the read model are encoding-independent. Unparseable
 * strings are flagged rather than rejected.
 */
export function normaliseCid(raw: string): NormalisedCid {
  try {
    const cid = CID.parse(raw);
    return { cid: cid.toV1().toString(base32), raw, valid: true };
  } catch {
    return { cid: null, raw, valid: false };
  }
}

/**
 * Ledger of the event currently being applied. Set by applyEvent so the
 * validity-range helpers below can close/open ranges without threading the
 * ledger through every call site.
 */
let currentLedger = 0;

/**
 * Close the open validity range for an entity and open a new one starting at
 * `ledger`. Ranges are half-open `[from_ledger, to_ledger)`. The close is a
 * no-op when the open range already starts at `ledger` (replay of the same
 * event), and the insert is an upsert keyed on `(entity, from_ledger)` so a
 * cursor rewind converges instead of duplicating rows.
 */
async function openRange(
  db: Queryable,
  table: 'folder_versions' | 'portfolio_versions' | 'template_versions',
  keyColumn: 'owner' | 'id',
  key: string,
  ledger: number,
  columns: string[],
  values: unknown[]
): Promise<void> {
  await db.query(
    `UPDATE ${table} SET to_ledger = $2
     WHERE ${keyColumn} = $1 AND to_ledger IS NULL AND from_ledger < $2`,
    [key, ledger]
  );
  const allColumns = [keyColumn, 'from_ledger', 'to_ledger', ...columns];
  const placeholders = allColumns.map((_, i) => `$${i + 1}`).join(', ');
  const updates = columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await db.query(
    `INSERT INTO ${table} (${allColumns.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (${keyColumn}, from_ledger) DO UPDATE SET ${updates}`,
    [key, ledger, null, ...values]
  );
}

/**
 * Outcome of applying one event. `orphaned` means the event updates a row that
 * does not exist yet (the indexer started partway through history, or the
 * parent event is later in the same page); it is stored and re-applied when the
 * parent row arrives.
 */
export type ApplyOutcome = 'applied' | 'orphaned';

/**
 * Surrogate keys (CDN cache tags) for the read model rows an event touches.
 * The indexer purges these after the page commits; the API sends the same
 * keys in `Surrogate-Key` / `Cache-Tag` headers (see docs/api.md).
 */
export function cacheTagsFor(event: DecodedEvent): string[] {
  switch (event.topic) {
    case 'init':
    case 'adm_add':
    case 'adm_rm':
      return [];
    case 'folder_cl':
      return [`folder:${event.owner}`, `folder-name:${event.folderName}`];
    case 'tmpl_reg':
      return [`template:${event.templateId}`, 'templates'];
    case 'tmpl_set':
      return [`folder:${event.owner}`, `portfolio:${event.owner}`, `template:${event.templateId}`];
    case 'port_mint':
      return [`portfolio:${event.owner}`, `folder:${event.owner}`, `template:${event.templateId}`];
    case 'port_upd':
      return [`portfolio:${event.owner}`];
  }
}

/**
 * Apply one decoded contract event to the read model. Runs inside the page
 * transaction (see processPage); `at` is the ledger close time of the event.
 * Each event id is applied at most once, so handlers don't need to be
 * idempotent on their own, but they are written as upserts anyway so a manual
 * cursor rewind (docs/operations.md) converges to the same state.
 */
export async function applyEvent(db: Queryable, event: DecodedEvent, at: Date): Promise<void> {
  currentLedger = event.ledger;
  switch (event.topic) {
    case 'init':
      await recordAdminChange(db, eventId, ledger, 'init', null, event.admin, at);
      await db.query(
        network
          ? 'INSERT INTO admins (network, contract_id, address, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT (network, address) DO NOTHING'
          : 'INSERT INTO admins (address, added_at) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING',
        network ? [network, contractId, event.admin, at] : [event.admin, at]
      );
      return 'applied';

    case 'adm_add':
      await recordAdminChange(db, eventId, ledger, 'add', event.admin, event.newAdmin, at);
      await db.query(
        network
          ? 'INSERT INTO admins (network, contract_id, address, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT (network, address) DO NOTHING'
          : 'INSERT INTO admins (address, added_at) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING',
        network ? [network, contractId, event.newAdmin, at] : [event.newAdmin, at]
      );
      return 'applied';

    case 'adm_rm':
      await recordAdminChange(db, eventId, ledger, 'remove', event.admin, event.target, at);
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
      await openRange(db, 'folder_versions', 'owner', event.owner, event.ledger, ['name'], [
        event.folderName,
      ]);
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
      // Dense, replay-stable version number: count of prior versions + 1.
      await db.query(
        `INSERT INTO template_versions
           (id, version, metadata_uri, creator, event_id, at, from_ledger, to_ledger)
         VALUES (
           $1,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM template_versions WHERE id = $1),
           $2, $3, $4, $5, $6, NULL)
         ON CONFLICT (id, version) DO UPDATE
           SET metadata_uri = EXCLUDED.metadata_uri, creator = EXCLUDED.creator,
               event_id = EXCLUDED.event_id, at = EXCLUDED.at,
               from_ledger = EXCLUDED.from_ledger, to_ledger = NULL`,
        [event.templateId, event.metadataUri, event.creator, event.eventId, at, event.ledger]
      );
      await openRange(
        db,
        'template_versions',
        'id',
        event.templateId,
        event.ledger,
        ['metadata_uri', 'creator', 'event_id', 'at'],
        [event.metadataUri, event.creator, event.eventId, at]
      );
      return;

    case 'tmpl_set': {
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
      await openRange(db, 'folder_versions', 'owner', event.owner, event.ledger, ['template_id'], [
        event.templateId,
      ]);
      await openRange(
        db,
        'portfolio_versions',
        'owner',
        event.owner,
        event.ledger,
        ['template_id'],
        [event.templateId]
      );
      return;

    case 'port_mint': {
      // mint_portfolio also sets the owner's selected template.
      const cid = normaliseCid(event.ipfsCid);
      await db.query(
        `INSERT INTO portfolios
           (owner, template_id, ipfs_cid, ipfs_cid_raw, cid_valid, minted_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (owner) DO UPDATE
           SET template_id = EXCLUDED.template_id, ipfs_cid = EXCLUDED.ipfs_cid,
               ipfs_cid_raw = EXCLUDED.ipfs_cid_raw, cid_valid = EXCLUDED.cid_valid,
               updated_at = EXCLUDED.updated_at`,
        [event.owner, event.templateId, cid, at]
      );
      await db.query('UPDATE folders SET template_id = $2, updated_at = $3 WHERE owner = $1', [
        event.owner,
        event.templateId,
        at,
      ]);
      await db.query(
        `INSERT INTO portfolio_versions
           (owner, version, cid, template_id, event_id, at, from_ledger, to_ledger)
         VALUES (
           $1,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM portfolio_versions WHERE owner = $1),
           $2, $3, $4, $5, $6, NULL)
         ON CONFLICT (owner, version) DO UPDATE
           SET cid = EXCLUDED.cid, template_id = EXCLUDED.template_id,
               event_id = EXCLUDED.event_id, at = EXCLUDED.at,
               from_ledger = EXCLUDED.from_ledger, to_ledger = NULL`,
        [event.owner, cid, event.templateId, event.eventId, at, event.ledger]
      );
      await openRange(
        db,
        'portfolio_versions',
        'owner',
        event.owner,
        event.ledger,
        ['cid', 'template_id', 'event_id', 'at'],
        [cid, event.templateId, event.eventId, at]
      );
      await openRange(db, 'folder_versions', 'owner', event.owner, event.ledger, ['template_id'], [
        event.templateId,
      ]);
      return;
    }

    case 'port_upd': {
      const cid = normaliseCid(event.ipfsCid);
      await db.query('UPDATE portfolios SET ipfs_cid = $2, updated_at = $3 WHERE owner = $1', [
        event.owner,
        cid,
        at,
      ]);
      await db.query(
        `INSERT INTO portfolio_versions
           (owner, version, cid, template_id, event_id, at, from_ledger, to_ledger)
         VALUES (
           $1,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM portfolio_versions WHERE owner = $1),
           $2,
           (SELECT template_id FROM portfolios WHERE owner = $1),
           $3, $4, $5, NULL)
         ON CONFLICT (owner, version) DO UPDATE
           SET cid = EXCLUDED.cid, template_id = EXCLUDED.template_id,
               event_id = EXCLUDED.event_id, at = EXCLUDED.at,
               from_ledger = EXCLUDED.from_ledger, to_ledger = NULL`,
        [event.owner, cid, event.eventId, at, event.ledger]
      );
      await openRange(
        db,
        'portfolio_versions',
        'owner',
        event.owner,
        event.ledger,
        ['cid', 'event_id', 'at'],
        [cid, event.eventId, at]
      );
      return;

    default: {
      // Exhaustiveness check: if a new topic is added to DecodedEvent without a
      // handler above, `event` is no longer `never` here and this fails to compile.
      const unhandled: never = event;
      throw new Error(`unhandled event topic: ${JSON.stringify(unhandled)}`);
    }
  }
  return reapplied;
}
