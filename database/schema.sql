-- Folder indexer schema. Idempotent: safe to apply on every start.
-- Source of truth for both `npm run db:migrate` and the docker-compose Postgres init.
-- Tables mirror the events in Indexer-Contract docs/EVENTS.md.

-- Every contract event the indexer has seen, keyed by the RPC event id
-- (a TOID encoding ledger, transaction, operation and event index).
-- The primary key makes reprocessing a page a no-op.
CREATE TABLE IF NOT EXISTS contract_events (
  id                TEXT PRIMARY KEY,
  ledger            INTEGER NOT NULL,
  ledger_closed_at  TIMESTAMPTZ NOT NULL,
  tx_hash           TEXT NOT NULL,
  contract_id       TEXT NOT NULL,
  topic             TEXT NOT NULL,
  topic_xdr         TEXT[] NOT NULL,
  value_xdr         TEXT NOT NULL,
  data              JSONB,
  status            TEXT NOT NULL CHECK (status IN ('applied', 'ignored', 'rejected', 'orphaned')),
  error             TEXT,
  indexed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Older databases were created with a CHECK that predates 'orphaned'.
ALTER TABLE contract_events DROP CONSTRAINT IF EXISTS contract_events_status_check;
ALTER TABLE contract_events ADD CONSTRAINT contract_events_status_check
  CHECK (status IN ('applied', 'ignored', 'rejected', 'orphaned'));

CREATE INDEX IF NOT EXISTS idx_contract_events_ledger ON contract_events (ledger);
CREATE INDEX IF NOT EXISTS idx_contract_events_rejected
  ON contract_events (indexed_at) WHERE status = 'rejected';
CREATE INDEX IF NOT EXISTS idx_contract_events_orphaned
  ON contract_events (indexed_at) WHERE status = 'orphaned';

-- Read-model rows carry `last_event_id`, the contract_events row that last wrote
-- them. Event ids are TOIDs, so they sort in ledger/transaction/operation order:
-- every write is guarded by `last_event_id < $event_id`, which makes stale or
-- out-of-order events no-ops and keeps the read model monotonic.

-- folder_cl (owner <-> folder_name); template_id tracks tmpl_set / port_mint.
CREATE TABLE IF NOT EXISTS folders (
  owner          TEXT PRIMARY KEY,
  name           TEXT UNIQUE NOT NULL,
  template_id    BIGINT,
  claimed_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  last_event_id  TEXT NOT NULL REFERENCES contract_events (id)
);

-- tmpl_reg
CREATE TABLE IF NOT EXISTS templates (
  id             BIGINT PRIMARY KEY,
  metadata_uri   TEXT NOT NULL,
  creator        TEXT,
  registered_at  TIMESTAMPTZ NOT NULL,
  last_event_id  TEXT NOT NULL REFERENCES contract_events (id)
);

-- port_mint / port_upd / tmpl_set. No foreign key to folders: the indexer can
-- start partway through history, so a portfolio may arrive before its folder.
CREATE TABLE IF NOT EXISTS portfolios (
  owner          TEXT PRIMARY KEY,
  template_id    BIGINT NOT NULL,
  ipfs_cid       TEXT NOT NULL,
  minted_at      TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  last_event_id  TEXT NOT NULL REFERENCES contract_events (id)
);

-- init / adm_add / adm_rm. `removed_at` is set by adm_rm instead of deleting the
-- row, so the removal keeps its provenance and a stale adm_add can't resurrect it.
CREATE TABLE IF NOT EXISTS admins (
  address        TEXT PRIMARY KEY,
  added_at       TIMESTAMPTZ NOT NULL,
  removed_at     TIMESTAMPTZ,
  last_event_id  TEXT NOT NULL REFERENCES contract_events (id)
);

-- Upgrade a database created before last_event_id existed. Rows written by the old
-- indexer have no provenance, so they are dropped and rebuilt from contract_events
-- on the next replay (docs/operations.md). The tables are recreated above.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['folders', 'templates', 'portfolios', 'admins'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = t AND column_name = 'last_event_id'
    ) THEN
      EXECUTE format('DROP TABLE %I CASCADE', t);
    END IF;
  END LOOP;
END
$$;

-- folder_cl (owner <-> folder_name); template_id tracks tmpl_set / port_mint.
CREATE TABLE IF NOT EXISTS folders (
  owner          TEXT PRIMARY KEY,
  name           TEXT UNIQUE NOT NULL,
  template_id    BIGINT,
  claimed_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  last_event_id  TEXT NOT NULL REFERENCES contract_events (id)
);

-- Every folder_cl claim, including names later moved to another owner.
CREATE TABLE IF NOT EXISTS folder_name_history (
  name         TEXT NOT NULL,
  owner        TEXT NOT NULL,
  claimed_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (name, owner, claimed_at)
);

CREATE INDEX IF NOT EXISTS idx_folder_name_history_name ON folder_name_history (name);

-- tmpl_reg
CREATE TABLE IF NOT EXISTS templates (
  id             BIGINT PRIMARY KEY,
  metadata_uri   TEXT NOT NULL,
  creator        TEXT,
  registered_at  TIMESTAMPTZ NOT NULL,
  last_event_id  TEXT NOT NULL REFERENCES contract_events (id)
);

-- port_mint / port_upd / tmpl_set. No foreign key to folders: the indexer can
-- start partway through history, so a portfolio may arrive before its folder.
CREATE TABLE IF NOT EXISTS portfolios (
  owner          TEXT PRIMARY KEY,
  template_id    BIGINT NOT NULL,
  ipfs_cid       TEXT NOT NULL,
  minted_at      TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  last_event_id  TEXT NOT NULL REFERENCES contract_events (id)
);

-- init / adm_add / adm_rm. `removed_at` is set by adm_rm instead of deleting the
-- row, so the removal keeps its provenance and a stale adm_add can't resurrect it.
CREATE TABLE IF NOT EXISTS admins (
  address        TEXT PRIMARY KEY,
  added_at       TIMESTAMPTZ NOT NULL,
  removed_at     TIMESTAMPTZ,
  last_event_id  TEXT NOT NULL REFERENCES contract_events (id)
);

-- Indexer cursor and status, written in the same transaction as event data.
-- `version` is bumped by every write; a page only commits its cursor if the
-- version it read is still current, so a concurrent `reset-cursor` wins.
CREATE TABLE IF NOT EXISTS indexer_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  version     BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit trail for operator commands (e.g. `reset-cursor`).
CREATE TABLE IF NOT EXISTS operator_actions (
  id          BIGSERIAL PRIMARY KEY,
  action      TEXT NOT NULL,
  target      TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
