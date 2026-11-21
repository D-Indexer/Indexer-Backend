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

-- Append-only history of admin set changes (init / adm_add / adm_rm). Never
-- deleted, so "who was an admin at ledger N?" and "who removed whom?" stay
-- answerable. `actor` is the admin that emitted the event (NULL for init).
CREATE TABLE IF NOT EXISTS admin_changes (
  event_id  TEXT PRIMARY KEY,
  ledger    INTEGER NOT NULL,
  action    TEXT NOT NULL CHECK (action IN ('init', 'add', 'remove')),
  actor     TEXT,
  target    TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_changes_target ON admin_changes (target, ledger);
CREATE INDEX IF NOT EXISTS idx_admin_changes_ledger ON admin_changes (ledger);

-- Current-state projection of admin_changes: one row per current admin.
-- added_at / added_by / added_event_id describe the most recent add.
CREATE TABLE IF NOT EXISTS admins (
  address         TEXT PRIMARY KEY,
  added_at        TIMESTAMPTZ NOT NULL,
  added_by        TEXT,
  added_event_id  TEXT
);

-- Membership as of the end of `ledger`: the last change per address at or
-- before that ledger, keeping only addresses whose last change was an add.
CREATE OR REPLACE VIEW admins_at_ledger AS
SELECT DISTINCT ON (target) target AS address, ledger, action, actor, at
FROM admin_changes
WHERE ledger <= $1
ORDER BY target, ledger DESC, event_id DESC;

-- Indexer cursor and status, written in the same transaction as event data.
CREATE TABLE IF NOT EXISTS indexer_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
