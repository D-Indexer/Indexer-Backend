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
  status            TEXT NOT NULL CHECK (status IN ('applied', 'ignored', 'rejected')),
  error             TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  last_retry_at     TIMESTAMPTZ,
  indexed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Columns added after the first release; keep the schema idempotent.
ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contract_events_ledger ON contract_events (ledger);
CREATE INDEX IF NOT EXISTS idx_contract_events_rejected
  ON contract_events (indexed_at) WHERE status = 'rejected';

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

-- Every retention/config/manual gap: ledgers that were never indexed.
-- `filled_at` is set by an operator once the range has been backfilled.
CREATE TABLE IF NOT EXISTS index_gaps (
  id           BIGSERIAL PRIMARY KEY,
  reason       TEXT NOT NULL CHECK (reason IN ('retention', 'config', 'manual')),
  missed_from  INTEGER NOT NULL,
  missed_to    INTEGER NOT NULL,
  resumed_at   INTEGER NOT NULL,
  filled_at    TIMESTAMPTZ,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (missed_from <= missed_to)
);

CREATE INDEX IF NOT EXISTS idx_index_gaps_open
  ON index_gaps (missed_from) WHERE filled_at IS NULL;
