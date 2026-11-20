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

-- Transactional outbox: one row per applied event and subscriber type, written
-- in the same transaction as the event data so delivery survives crashes.
-- idempotency_key is stable per row and used by sinks to de-duplicate
-- (at-least-once delivery).
CREATE TABLE IF NOT EXISTS outbox (
  id               BIGSERIAL PRIMARY KEY,
  event_id         TEXT,
  subscriber       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  idempotency_key  TEXT UNIQUE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until     TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_dispatch
  ON outbox (status, next_attempt_at);

-- Webhook subscriptions managed via the admin CLI.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                    BIGSERIAL PRIMARY KEY,
  url                   TEXT NOT NULL,
  topics                TEXT[] NOT NULL DEFAULT '{}',
  owner                 TEXT,
  secret                TEXT NOT NULL,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-attempt delivery log for webhook sinks.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               BIGSERIAL PRIMARY KEY,
  subscription_id  BIGINT REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
  outbox_id        BIGINT,
  status           TEXT NOT NULL,
  response_status  INTEGER,
  error            TEXT,
  attempted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhook_deliveries (subscription_id, attempted_at);

-- Changes feed: entity-level upserts/deletes derived from applied events in
-- commit order. The cursor is the contract_events id (TOID), which is stable
-- and monotonic in commit order, so the feed is replayable from the beginning
-- of indexed history.
CREATE OR REPLACE VIEW changes AS
SELECT
  id AS cursor,
  CASE topic
    WHEN 'fold_reg' THEN 'folder'
    WHEN 'tmpl_reg' THEN 'template'
    WHEN 'port_mint' THEN 'portfolio'
    WHEN 'port_upd' THEN 'portfolio'
    WHEN 'tmpl_set' THEN 'folder'
    WHEN 'adm_add' THEN 'admin'
    WHEN 'adm_rm' THEN 'admin'
    ELSE 'event'
  END AS entity,
  topic,
  ledger,
  ledger_closed_at,
  data
FROM contract_events
WHERE status = 'applied';
