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
  indexed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Decomposed TOID (see src/indexer/stellar.ts parseEventId). `toid` is the
  -- numeric part of the RPC event id; the rest are its bit fields.
  toid              BIGINT,
  tx_order          INTEGER,
  op_order          INTEGER,
  event_index       INTEGER
);

-- Backfill the TOID columns for rows written before they existed.
UPDATE contract_events
   SET toid        = split_part(id, '-', 1)::BIGINT,
       tx_order    = ((split_part(id, '-', 1)::BIGINT >> 12) & 1048575)::INTEGER,
       op_order    = (split_part(id, '-', 1)::BIGINT & 4095)::INTEGER,
       event_index = split_part(id, '-', 2)::INTEGER
 WHERE toid IS NULL
   AND id ~ '^[0-9]+-[0-9]+$';

CREATE INDEX IF NOT EXISTS idx_contract_events_ledger ON contract_events (ledger);
-- Canonical event ordering: matches RPC getEvents delivery order.
CREATE INDEX IF NOT EXISTS idx_contract_events_toid_event_index
  ON contract_events (toid, event_index);
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

-- Enriched transactions: one row per tx_hash seen in contract_events, filled by
-- the enrichment worker from RPC getTransaction (source account, fee, memo).
CREATE TABLE IF NOT EXISTS transactions (
  hash            TEXT PRIMARY KEY,
  ledger          INTEGER,
  source_account  TEXT,
  fee_charged     BIGINT,
  max_fee         BIGINT,
  memo_type       TEXT,
  memo            TEXT,
  successful      BOOLEAN,
  fee_bump        BOOLEAN NOT NULL DEFAULT FALSE,
  muxed_source    TEXT,
  envelope_xdr    TEXT,
  enriched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_ledger ON transactions (ledger);

-- Indexer cursor and status, written in the same transaction as event data.
CREATE TABLE IF NOT EXISTS indexer_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
