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
--
-- Keyed by a stable token id (not owner) so ownership transfers do not look
-- like a mint for the new owner plus orphaned data for the old one. `owner` is
-- an indexed attribute; owner-based endpoints query it directly.
CREATE TABLE IF NOT EXISTS portfolios (
  token_id     BIGINT PRIMARY KEY,
  owner        TEXT NOT NULL,
  template_id  BIGINT NOT NULL,
  ipfs_cid     TEXT NOT NULL,
  minted_at    TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);

-- Idempotent migration for databases created before the token_id key.
-- Adds token_id when missing and backfills it for existing rows. Legacy rows
-- were keyed by owner, so a deterministic hash of the owner is used as the
-- token id; this keeps the backfill stable across re-runs.
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS token_id BIGINT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'portfolios'
      AND column_name = 'token_id'
      AND is_nullable = 'YES'
  ) THEN
    UPDATE portfolios
       SET token_id = ('x' || substr(md5(owner), 1, 15))::bit(60)::bigint
     WHERE token_id IS NULL;

    ALTER TABLE portfolios ALTER COLUMN token_id SET NOT NULL;
  END IF;
END $$;

-- Replace the legacy owner primary key with the token_id primary key.
DO $$
DECLARE
  pk_name TEXT;
BEGIN
  SELECT conname INTO pk_name
    FROM pg_constraint
   WHERE conrelid = 'portfolios'::regclass
     AND contype = 'p';

  IF pk_name IS NOT NULL AND pk_name <> 'portfolios_pkey' THEN
    EXECUTE format('ALTER TABLE portfolios DROP CONSTRAINT %I', pk_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'portfolios'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE portfolios ADD CONSTRAINT portfolios_pkey PRIMARY KEY (token_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_portfolios_owner ON portfolios (owner);

-- Ownership history for portfolios. One row per ownership period; the current
-- owner is the row with the greatest acquired_at for a token_id. event_id
-- references contract_events.id so a transfer can be traced to its event.
CREATE TABLE IF NOT EXISTS ownership_history (
  token_id     BIGINT NOT NULL,
  owner        TEXT NOT NULL,
  acquired_at  TIMESTAMPTZ NOT NULL,
  event_id     TEXT,
  PRIMARY KEY (token_id, acquired_at)
);

CREATE INDEX IF NOT EXISTS idx_ownership_history_token
  ON ownership_history (token_id);

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
