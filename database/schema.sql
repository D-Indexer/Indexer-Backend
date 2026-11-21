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
  -- Owner the event belongs to (folder_cl / tmpl_set / port_mint / port_upd),
  -- NULL for admin events and undecodable ones. Backs the per-owner activity feed.
  owner             TEXT,
  -- Owner the event belongs to (folder_cl / tmpl_set / port_mint / port_upd),
  -- NULL for admin events and undecodable ones. Backs the per-owner activity feed.
  owner             TEXT,
  status            TEXT NOT NULL CHECK (status IN ('applied', 'ignored', 'rejected')),
  error             TEXT,
  indexed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contract_events_rejected
  ON contract_events (indexed_at) WHERE status = 'rejected';
-- Per-owner activity feed: keyset pagination on (ledger, id) descending.
CREATE INDEX IF NOT EXISTS idx_contract_events_owner_activity
  ON contract_events (owner, ledger DESC, id DESC) WHERE status = 'applied';

-- Existing deployments: add the owner column and backfill it from the decoded
-- event data (idempotent, so it is safe on every start).
ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS owner TEXT;
UPDATE contract_events SET owner = data->>'owner'
  WHERE owner IS NULL AND data ? 'owner';

-- GET /events: keyset pagination on (ledger, id) and one index per filter.
CREATE INDEX IF NOT EXISTS idx_contract_events_ledger_id ON contract_events (ledger, id);
CREATE INDEX IF NOT EXISTS idx_contract_events_topic_ledger_id
  ON contract_events (topic, ledger, id);
CREATE INDEX IF NOT EXISTS idx_contract_events_status_ledger_id
  ON contract_events (status, ledger, id);
CREATE INDEX IF NOT EXISTS idx_contract_events_owner_ledger_id
  ON contract_events ((data->>'owner'), ledger, id);

-- folder_cl (owner <-> folder_name); template_id tracks tmpl_set / port_mint.
CREATE TABLE IF NOT EXISTS folders (
  owner        TEXT PRIMARY KEY,
  name         TEXT UNIQUE NOT NULL,
  template_id  BIGINT,
  claimed_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);

-- tmpl_reg
CREATE TABLE IF NOT EXISTS templates (
  id             BIGINT PRIMARY KEY,
  metadata_uri   TEXT NOT NULL,
  creator        TEXT,
  registered_at  TIMESTAMPTZ NOT NULL
);

-- port_mint / port_upd / tmpl_set. No foreign key to folders: the indexer can
-- start partway through history, so a portfolio may arrive before its folder.
CREATE TABLE IF NOT EXISTS portfolios (
  owner        TEXT PRIMARY KEY,
  template_id  BIGINT NOT NULL,
  ipfs_cid     TEXT NOT NULL,
  minted_at    TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);

-- init / adm_add / adm_rm
CREATE TABLE IF NOT EXISTS admins (
  address   TEXT PRIMARY KEY,
  added_at  TIMESTAMPTZ NOT NULL
);

-- Indexer cursor and status, written in the same transaction as event data.
CREATE TABLE IF NOT EXISTS indexer_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
