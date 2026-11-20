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
  indexed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contract_events_ledger ON contract_events (ledger);
CREATE INDEX IF NOT EXISTS idx_contract_events_rejected
  ON contract_events (indexed_at) WHERE status = 'rejected';
CREATE INDEX IF NOT EXISTS idx_contract_events_topic_ledger
  ON contract_events (topic, ledger);

-- folder_cl (owner <-> folder_name); template_id tracks tmpl_set / port_mint.
CREATE TABLE IF NOT EXISTS folders (
  owner        TEXT PRIMARY KEY,
  name         TEXT UNIQUE NOT NULL,
  template_id  BIGINT,
  claimed_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);

-- tmpl_reg. from_ledger/to_ledger form a half-open validity range
-- [from_ledger, to_ledger) for point-in-time reads; to_ledger is NULL while
-- the row is current.
CREATE TABLE IF NOT EXISTS templates (
  id             BIGINT PRIMARY KEY,
  metadata_uri   TEXT NOT NULL,
  creator        TEXT,
  registered_at  TIMESTAMPTZ NOT NULL,
  from_ledger    INTEGER,
  to_ledger      INTEGER
);

-- port_mint / port_upd / tmpl_set. No foreign key to folders: the indexer can
-- start partway through history, so a portfolio may arrive before its folder.
-- cid_normalized holds the CIDv1 base32 form for reverse lookups.
CREATE TABLE IF NOT EXISTS portfolios (
  owner           TEXT PRIMARY KEY,
  template_id     BIGINT NOT NULL,
  ipfs_cid        TEXT NOT NULL,
  cid_normalized  TEXT,
  minted_at       TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  from_ledger     INTEGER,
  to_ledger       INTEGER
);

-- Version history for portfolio content (port_mint / port_upd / tmpl_set).
-- Version numbers are dense per owner and stable under replay: the handler
-- derives the next version from the current max inside the page transaction.
CREATE TABLE IF NOT EXISTS portfolio_versions (
  owner           TEXT NOT NULL,
  version         INTEGER NOT NULL,
  ipfs_cid        TEXT NOT NULL,
  cid_normalized  TEXT,
  template_id     BIGINT NOT NULL,
  event_id        TEXT,
  at              TIMESTAMPTZ NOT NULL,
  from_ledger     INTEGER,
  to_ledger       INTEGER,
  PRIMARY KEY (owner, version)
);

-- Version history for template metadata (tmpl_reg re-registration).
CREATE TABLE IF NOT EXISTS template_versions (
  id             BIGINT NOT NULL,
  version        INTEGER NOT NULL,
  metadata_uri   TEXT NOT NULL,
  creator        TEXT,
  event_id       TEXT,
  at             TIMESTAMPTZ NOT NULL,
  from_ledger    INTEGER,
  to_ledger      INTEGER,
  PRIMARY KEY (id, version)
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

-- Point-in-time lookups: state at ledger L is the row whose validity range
-- contains L, found with a single indexed lookup on (owner, from_ledger).
CREATE INDEX IF NOT EXISTS idx_folders_owner_from_ledger
  ON folders (owner, from_ledger);
CREATE INDEX IF NOT EXISTS idx_portfolios_owner_from_ledger
  ON portfolios (owner, from_ledger);
CREATE INDEX IF NOT EXISTS idx_templates_id_from_ledger
  ON templates (id, from_ledger);

-- Reverse lookup of portfolios by CID (CIDv0 and CIDv1 of the same content
-- normalise to the same cid_normalized value).
CREATE INDEX IF NOT EXISTS idx_portfolios_cid_normalized
  ON portfolios (cid_normalized);
CREATE INDEX IF NOT EXISTS idx_portfolio_versions_cid_normalized
  ON portfolio_versions (cid_normalized);

-- Keyset pagination over version history.
CREATE INDEX IF NOT EXISTS idx_portfolio_versions_owner_version
  ON portfolio_versions (owner, version);
CREATE INDEX IF NOT EXISTS idx_template_versions_id_version
  ON template_versions (id, version);
CREATE INDEX IF NOT EXISTS idx_portfolio_versions_owner_from_ledger
  ON portfolio_versions (owner, from_ledger);
CREATE INDEX IF NOT EXISTS idx_template_versions_id_from_ledger
  ON template_versions (id, from_ledger);
