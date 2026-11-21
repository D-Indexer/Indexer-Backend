-- Folder indexer schema. Idempotent: safe to apply on every start.
-- Source of truth for both `npm run db:migrate` and the docker-compose Postgres init.
-- Tables mirror the events in Indexer-Contract docs/EVENTS.md.

-- Every contract event the indexer has seen, keyed by the RPC event id
-- (a TOID encoding ledger, transaction, operation and event index).
-- The primary key makes reprocessing a page a no-op.
CREATE TABLE IF NOT EXISTS contract_events (
  network           TEXT NOT NULL DEFAULT '',
  id                TEXT NOT NULL,
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
  indexed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (network, id)
);

CREATE INDEX IF NOT EXISTS idx_contract_events_ledger ON contract_events (ledger);
CREATE INDEX IF NOT EXISTS idx_contract_events_rejected
  ON contract_events (indexed_at) WHERE status = 'rejected';

-- folder_cl (owner <-> folder_name); template_id tracks tmpl_set / port_mint.
CREATE TABLE IF NOT EXISTS folders (
  network      TEXT NOT NULL DEFAULT '',
  contract_id  TEXT,
  owner        TEXT NOT NULL,
  name         TEXT NOT NULL,
  template_id  BIGINT,
  claimed_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, owner),
  UNIQUE (network, name)
);

-- tmpl_reg
CREATE TABLE IF NOT EXISTS templates (
  network        TEXT NOT NULL DEFAULT '',
  contract_id    TEXT,
  id             BIGINT NOT NULL,
  metadata_uri   TEXT NOT NULL,
  creator        TEXT,
  registered_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, id)
);

-- port_mint / port_upd / tmpl_set. No foreign key to folders: the indexer can
-- start partway through history, so a portfolio may arrive before its folder.
CREATE TABLE IF NOT EXISTS portfolios (
  network      TEXT NOT NULL DEFAULT '',
  contract_id  TEXT,
  owner        TEXT NOT NULL,
  template_id  BIGINT NOT NULL,
  ipfs_cid     TEXT NOT NULL,
  minted_at    TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, owner)
);

-- init / adm_add / adm_rm
CREATE TABLE IF NOT EXISTS admins (
  network     TEXT NOT NULL DEFAULT '',
  contract_id TEXT,
  address     TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, address)
);

-- Indexer cursor and status, written in the same transaction as event data.
CREATE TABLE IF NOT EXISTS indexer_state (
  network     TEXT NOT NULL DEFAULT '',
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (network, key)
);

-- Upgrade an existing single-network database in place.
ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT '';
ALTER TABLE folders ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT '';
ALTER TABLE folders ADD COLUMN IF NOT EXISTS contract_id TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT '';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS contract_id TEXT;
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT '';
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS contract_id TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT '';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS contract_id TEXT;
ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  ALTER TABLE contract_events DROP CONSTRAINT IF EXISTS contract_events_pkey;
  ALTER TABLE contract_events ADD CONSTRAINT contract_events_pkey PRIMARY KEY (network, id);
  ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_pkey;
  ALTER TABLE folders ADD CONSTRAINT folders_pkey PRIMARY KEY (network, owner);
  ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_name_key;
  ALTER TABLE folders ADD CONSTRAINT folders_name_key UNIQUE (network, name);
  ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_pkey;
  ALTER TABLE templates ADD CONSTRAINT templates_pkey PRIMARY KEY (network, id);
  ALTER TABLE portfolios DROP CONSTRAINT IF EXISTS portfolios_pkey;
  ALTER TABLE portfolios ADD CONSTRAINT portfolios_pkey PRIMARY KEY (network, owner);
  ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_pkey;
  ALTER TABLE admins ADD CONSTRAINT admins_pkey PRIMARY KEY (network, address);
  ALTER TABLE indexer_state DROP CONSTRAINT IF EXISTS indexer_state_pkey;
  ALTER TABLE indexer_state ADD CONSTRAINT indexer_state_pkey PRIMARY KEY (network, key);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;
