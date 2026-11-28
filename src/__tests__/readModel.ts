import type { Queryable } from '../db/types';
import type { DecodedEvent } from '../indexer/decode';
import { updateCounters } from '../indexer/counters';

/**
 * Test stand-in for the indexer's per-event pipeline (storeEvent + applyEvent)
 * for the events that drive derived counters. It keeps their order and
 * transaction semantics: an event is inserted into contract_events, counters
 * are updated only if that insert was new, and the counter update runs before
 * the read-model write. A rejected event's changes are rolled back to a
 * savepoint, as in storeEvent.
 *
 * The real modules can't be used here yet: handlers.ts imports modules that
 * don't exist (`multiformats`, `../services/cid`) and writes columns that
 * database/schema.sql doesn't define (e.g. portfolios.ipfs_cid_raw,
 * folder_versions).
 */
export interface FixtureEvent {
  id: string;
  ledger: number;
  at: string;
  event: DecodedEvent;
  /** Simulate the handler hitting a deterministic DB error. */
  reject?: boolean;
}

async function applyReadModel(db: Queryable, event: DecodedEvent, at: Date): Promise<void> {
  switch (event.topic) {
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
         ON CONFLICT (id) DO UPDATE SET metadata_uri = EXCLUDED.metadata_uri, creator = EXCLUDED.creator`,
        [event.templateId, event.metadataUri, event.creator, at]
      );
      return;
    case 'port_mint':
      await db.query(
        `INSERT INTO portfolios (owner, template_id, ipfs_cid, minted_at, updated_at) VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (owner) DO UPDATE
           SET template_id = EXCLUDED.template_id, ipfs_cid = EXCLUDED.ipfs_cid, updated_at = EXCLUDED.updated_at`,
        [event.owner, event.templateId, event.ipfsCid, at]
      );
      return;
    case 'tmpl_set':
      await db.query('UPDATE portfolios SET template_id = $2, updated_at = $3 WHERE owner = $1', [
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
    default:
      return;
  }
}

/** Returns false when the event id was already stored (a replay). */
export async function ingest(db: Queryable, fx: FixtureEvent): Promise<boolean> {
  const at = new Date(fx.at);
  await db.query('BEGIN');
  try {
    // contract_events.id is unique in production (ON CONFLICT (id) DO NOTHING);
    // the test schema can't enforce that on the partitioned table, so check first.
    const existing = await db.query('SELECT 1 FROM contract_events WHERE id = $1', [fx.id]);
    if (existing.rows.length > 0) {
      await db.query('COMMIT');
      return false;
    }
    await db.query(
      `INSERT INTO contract_events
         (id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status)
       VALUES ($1, $2, $3, 'tx', 'C', $4, '{}', '', $5, 'applied')`,
      [fx.id, fx.ledger, at, fx.event.topic, JSON.stringify(fx.event)]
    );
    await db.query('SAVEPOINT apply_event');
    await updateCounters(db, fx.event, at);
    await applyReadModel(db, fx.event, at);
    if (fx.reject) {
      await db.query('ROLLBACK TO SAVEPOINT apply_event');
      await db.query("UPDATE contract_events SET status = 'rejected' WHERE id = $1", [fx.id]);
    } else {
      await db.query('RELEASE SAVEPOINT apply_event');
    }
    await db.query('COMMIT');
    return true;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
