-- Folder indexer schema. Idempotent: safe to apply on every start.
-- Source of truth for both `npm run db:migrate` and the docker-compose Postgres init.
-- Tables mirror the events in Indexer-Contract docs/EVENTS.md.

-- Every contract event the indexer has seen, keyed by the RPC event id
-- (a TOID encoding ledger, transaction, operation and event index).
--
-- Declaratively range-partitioned on `ledger` (one partition per
-- CONTRACT_EVENTS_PARTITION_SIZE ledgers, see src/indexer/stellar.ts). The
-- primary key must include the partition key, so it is (ledger, id); a
-- separate unique index on `id` keeps idempotent inserts working via
-- ON CONFLICT (id) DO NOTHING. A DEFAULT partition is the safety net for any
-- ledger range that has not had a partition created ahead of time.
CREATE TABLE IF NOT EXISTS contract_events (
  id                TEXT NOT NULL,
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
  indexed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ledger, id)
) PARTITION BY RANGE (ledger);

-- Safety net: rows whose ledger has no dedicated partition land here.
CREATE TABLE IF NOT EXISTS contract_events_default
  PARTITION OF contract_events DEFAULT;

-- Unique lookup on id (the RPC event id) so duplicate events remain no-ops.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_events_id ON contract_events (id);
CREATE INDEX IF NOT EXISTS idx_contract_events_ledger ON contract_events (ledger);
-- Canonical event ordering: matches RPC getEvents delivery order.
CREATE INDEX IF NOT EXISTS idx_contract_events_toid_event_index
  ON contract_events (toid, event_index);
CREATE INDEX IF NOT EXISTS idx_contract_events_rejected
  ON contract_events (indexed_at) WHERE status = 'rejected';
CREATE INDEX IF NOT EXISTS idx_contract_events_topic_ledger
  ON contract_events (topic, ledger);

-- folder_cl (owner <-> folder_name); template_id tracks tmpl_set / port_mint.
-- live_until_ledger is the TTL of the folder's persistent storage entry as
-- reported by getLedgerEntries; NULL means not yet probed.
CREATE TABLE IF NOT EXISTS folders (
  owner          TEXT PRIMARY KEY,
  name           TEXT UNIQUE NOT NULL,
  template_id    BIGINT,
  claimed_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  last_event_id  TEXT NOT NULL REFERENCES contract_events (id)
);

-- Moderation: a hidden folder/portfolio is excluded from the listing endpoints.
-- Rows are keyed by the same key as the listed table (folders.owner / portfolios.owner).
CREATE TABLE IF NOT EXISTS hidden_folders (
  owner      TEXT PRIMARY KEY,
  hidden_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hidden_portfolios (
  owner      TEXT PRIMARY KEY,
  hidden_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keyset listing indexes. The trailing owner column makes each ordering total,
-- so a cursor on (timestamp, owner) never repeats or skips a row.
CREATE INDEX IF NOT EXISTS idx_folders_claimed_at ON folders (claimed_at, owner);
CREATE INDEX IF NOT EXISTS idx_portfolios_minted_at ON portfolios (minted_at, owner);
CREATE INDEX IF NOT EXISTS idx_portfolios_updated_at ON portfolios (updated_at, owner);

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

ALTER TABLE folders ADD COLUMN IF NOT EXISTS live_until_ledger INTEGER;
ALTER TABLE folders ADD COLUMN IF NOT EXISTS ttl_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_folders_live_until
  ON folders (live_until_ledger) WHERE live_until_ledger IS NOT NULL;

-- tmpl_reg
CREATE TABLE IF NOT EXISTS templates (
  network        TEXT NOT NULL DEFAULT '',
  contract_id    TEXT,
  id             BIGINT NOT NULL,
  metadata_uri   TEXT NOT NULL,
  creator        TEXT,
  registered_at  TIMESTAMPTZ NOT NULL,
  from_ledger    INTEGER,
  to_ledger      INTEGER
);

ALTER TABLE templates ADD COLUMN IF NOT EXISTS live_until_ledger INTEGER;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS ttl_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_templates_live_until
  ON templates (live_until_ledger) WHERE live_until_ledger IS NOT NULL;

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

ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS live_until_ledger INTEGER;
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS ttl_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_portfolios_live_until
  ON portfolios (live_until_ledger) WHERE live_until_ledger IS NOT NULL;

-- init / adm_add / adm_rm
CREATE TABLE IF NOT EXISTS admins (
  address        TEXT PRIMARY KEY,
  added_at       TIMESTAMPTZ NOT NULL,
  removed_at     TIMESTAMPTZ,
  last_event_id  TEXT NOT NULL REFERENCES contract_events (id)
);

-- Membership as of the end of `ledger`: the last change per address at or
-- before that ledger, keeping only addresses whose last change was an add.
CREATE OR REPLACE VIEW admins_at_ledger AS
SELECT DISTINCT ON (target) target AS address, ledger, action, actor, at
FROM admin_changes
WHERE ledger <= $1
ORDER BY target, ledger DESC, event_id DESC;

-- Indexer cursor and status, written in the same transaction as event data.
-- `version` is bumped by every write; a page only commits its cursor if the
-- version it read is still current, so a concurrent `reset-cursor` wins.
CREATE TABLE IF NOT EXISTS indexer_state (
  network     TEXT NOT NULL DEFAULT '',
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  version     BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Runtime feature flags for incident response. Read by the API and indexer
-- with a short cache TTL; changes are audited via updated_by / updated_at /
-- note. Rows are upserted by the `flags set` CLI command.
CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note        TEXT
);

-- NOTIFY-based cache invalidation: every insert/update/delete on feature_flags
-- broadcasts the affected key on the `feature_flags_changed` channel so
-- replicas can drop their cached value immediately instead of waiting for the
-- TTL to expire. Listeners should treat the payload as a hint and re-read.
CREATE OR REPLACE FUNCTION notify_feature_flags_changed() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'feature_flags_changed',
    COALESCE(NEW.key, OLD.key)
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_feature_flags_changed ON feature_flags;
CREATE TRIGGER trg_feature_flags_changed
  AFTER INSERT OR UPDATE OR DELETE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION notify_feature_flags_changed();
