# Operations

How to run, observe and recover the indexer, the database and IPFS. Configuration is in
[configuration.md](configuration.md).

## Processes

| Process | Command                                         | Image command                   |
| ------- | ----------------------------------------------- | ------------------------------- |
| API     | `npm start` (`npm run dev` for hot reload)      | `node dist/server.js` (default) |
| Indexer | `npm run start:indexer` (`npm run dev:indexer`) | `node dist/indexer/main.js`     |

Run exactly **one** indexer per database. Two would not corrupt data, since event ids
deduplicate, but they would race on the cursor and waste RPC calls. The API can scale
horizontally.

## Health

- **API**: `GET /health` returns `200` when Postgres answers, `503` otherwise, and includes
  the indexer's status ([api.md](api.md#get-health)). The image's `HEALTHCHECK` uses it.
- **Indexer**: `npm run indexer -- healthcheck` (or `node dist/indexer/cli.js healthcheck`
  in the image) exits `1` if the indexer hasn't completed a poll within
  `INDEXER_STALE_AFTER_MS`. docker-compose uses it as the indexer's healthcheck.
- **State**: `npm run indexer -- status` prints `indexer_state`:

```json
{
  "cursor": "0024284788768636927-4294967295",
  "last_ledger": "5654242",
  "last_success_at": "2026-11-10T07:37:30.225Z",
  "status": "ok"
}
```

Logs are single lines (`<ISO time> <LEVEL> <message> <json context>`) on stdout/stderr.
`LOG_LEVEL=debug` adds more detail. RPC URLs in logs have credentials and query strings
removed.

### Error reporting

Unhandled errors (API and indexer) are reported through an `ErrorReporter` interface. It is
a no-op unless `ERROR_TRACKING_DSN` is set; with no DSN nothing is sent and there is no
overhead. When enabled, reports include the stack trace, request id, route template (never
the raw URL), release version (`RELEASE`/`GIT_SHA`) and environment (`NODE_ENV`).

Payloads are scrubbed before leaving the process: query strings, request bodies, headers
except an allow-list, `DATABASE_URL`, RPC URLs (via `redactUrl`) and IP addresses are
removed or redacted. Indexer errors are grouped by error class plus SQLSTATE/RPC code so
recurring failures aggregate instead of flooding.

To enable, set `ERROR_TRACKING_DSN` to your provider's DSN and restart. To disable, unset
it. Never point it at a project that isn't access-controlled: reports still contain stack
traces and route names.

What to alert on:

- `/health` `indexer.stale` is `true`, or `indexer.status` is `retention_gap`
- `Indexer poll failed` logged repeatedly (the `failures` count grows)
- rows in `contract_events` with `status = 'rejected'`

## Indexer recovery

### Retention gap

Soroban RPC keeps only recent ledgers (testnet: about 7 days). If the indexer is down longer
than that, its saved cursor points before the oldest retained ledger. You'll see:

```text
ERROR Indexer halted: retention gap {"error":"Saved cursor is at ledger 5000000, but the RPC only retains ledgers from 5533280. ..."}
```

`/health` then shows `"indexer": {"status": "retention_gap", ...}`. The indexer keeps
checking with backoff but doesn't move. Choose one:

1. **Accept the gap** and continue from the oldest retained ledger. Events in the gap are
   missing from the read model. The window moves forward every ledger, so leave a margin:
   ```bash
   npm run indexer -- reset-cursor <oldest ledger from the error + 100>
   # in the container image (no ts-node there):
   docker compose exec indexer node dist/indexer/cli.js reset-cursor <ledger>
   ```
   Or set `INDEXER_ON_RETENTION_GAP=skip` and restart. It does the same automatically
   now and in future, recording the gap in `indexer_state.last_gap`.
2. **Rebuild from an RPC with longer retention.** Point `STELLAR_RPC_URL` at an RPC that
   still has the missing ledgers (self-hosted with a larger retention window, or a provider
   with history), run `reset-cursor` to the first missing ledger, and let it catch up. Then
   switch back if you like.
3. **Backfill from archives.** Not implemented yet (tracked as a GitHub issue). It would
   read the missing ledgers from history archives or Galexie data.

On an empty database the indexer never halts: an `INDEXER_START_LEDGER` older than the window
is clamped to the oldest retained ledger with a warning.

### Re-index from a ledger

`reset-cursor` is safe at any time because events are deduplicated by id. Rewinding
re-reads events and skips the ones already stored. To rebuild the read model from scratch:

```sql
TRUNCATE contract_events, folders, templates, portfolios, admins, indexer_state;
```

```bash
npm run indexer -- reset-cursor <first ledger to index>   # or leave state empty to use INDEXER_START_LEDGER
```

### Rejected events

```sql
SELECT id, ledger, tx_hash, topic, error FROM contract_events WHERE status = 'rejected';
```

A rejected event usually means the contract emitted something the decoder doesn't expect
(a changed field type) or the read model contradicts it. Fix the decoder or handler, delete
those rows, and rewind:

```sql
DELETE FROM contract_events WHERE status = 'rejected';
```

```bash
npm run indexer -- reset-cursor <ledger of the first rejected event>
```

### RPC errors

Timeouts, 429 and 5xx are retried three times per call, then the poll backs off
exponentially up to `INDEXER_MAX_BACKOFF_MS`. Nothing needs doing unless failures persist.
`startLedger must be within the ledger range` with a ledger _ahead_ of the RPC means the RPC
is behind or misconfigured (wrong network).

### Contract redeployed

A new contract id means new events. Set `FOLDER_CONTRACT_ID` (and `INDEXER_START_LEDGER` to
the deployment ledger), truncate the tables above, and restart the indexer.

## Database

### Startup and waiting for Postgres

The indexer and the migrate script wait for Postgres instead of crashing when it isn't up
yet. `waitForDatabase` retries `SELECT 1` with exponential backoff and jitter (capped by
`DB_WAIT_MAX_DELAY_MS`, giving up after `DB_WAIT_TIMEOUT_MS`) and logs every attempt. This
means the indexer can start before Postgres (Kubernetes, ECS, plain `docker run`) without
crash-looping. The API does not wait: it starts immediately and reports not-ready via
`/health` until the database answers.

Some errors are fatal and exit immediately with a clear message instead of retrying:

- `28P01` — authentication failed (wrong password/user)
- `3D000` — database does not exist

Fix the credentials or create the database, then restart.

### Schema and migrations

- The schema is `database/schema.sql`. Every statement is `IF NOT EXISTS`, so applying it is
  idempotent: `npm run db:migrate`, the indexer at startup, and the compose Postgres init
  (first start of an empty volume) all apply it.
- **Upgrading from the pre-testnet schema**: migration refuses to run if `folders.cid` exists.
  That layout was never populated by the old indexer, which couldn't decode the contract's
  events. Drop it and migrate:
  ```sql
  DROP TABLE IF EXISTS credentials, folders, templates, indexer_state CASCADE;
  ```
- Backups: the read model can always be rebuilt from the ledger while events are in the RPC
  window. Beyond it, `contract_events` is the only copy, so back it up like any other
  database.
- Use a least-privilege role in production. It needs `CREATE` for the migration and
  read/write on the tables above.
- Connect locally to the compose database:
  `docker compose exec postgres psql -U folder folder`.

### Partitioning `contract_events`

`contract_events` is range-partitioned by `ledger`, one partition per
`CONTRACT_EVENTS_PARTITION_SIZE` ledgers (default 1,000,000, roughly two months). The
primary key is `(ledger, id)`; a unique index on `id` keeps event ids unique across
partitions, so `ON CONFLICT (id) DO NOTHING` still makes duplicate events no-ops.

The indexer creates partitions ahead of the cursor: before each poll it ensures partitions
exist up to `latestLedger + CONTRACT_EVENTS_PARTITION_LOOKAHEAD` ledgers. A `DEFAULT`
partition exists as a safety net, but in normal operation no insert lands there. If one
does, the indexer logs a warning — check that the indexer has `CREATE` on the schema and
that the lookahead is large enough for your RPC lag.

List partitions and their ranges:

```sql
SELECT child.relname AS partition,
       pg_get_expr(child.relpartbound, child.oid) AS bounds
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
WHERE parent.relname = 'contract_events'
ORDER BY child.relname;
```

Queries that filter on `ledger` prune partitions; confirm with `EXPLAIN`:

```sql
EXPLAIN SELECT count(*) FROM contract_events WHERE ledger BETWEEN 5000000 AND 5000999;
-- only the matching partition(s) appear in the plan
```

#### Online migration of an existing table

Existing deployments have a plain (non-partitioned) `contract_events`. Convert it without
downtime using a copy-and-swap. Run this during a quiet period (stop the indexer first so
no writes race the copy; the API can keep serving reads from the old table until the swap).

```sql
BEGIN;

-- 1. Rename the existing table out of the way.
ALTER TABLE contract_events RENAME TO contract_events_old;

-- 2. Create the partitioned parent (same columns as schema.sql).
CREATE TABLE contract_events (
  id          TEXT        NOT NULL,
  ledger      BIGINT      NOT NULL,
  tx_hash     TEXT        NOT NULL,
  topic       TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'applied',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ledger, id)
) PARTITION BY RANGE (ledger);

CREATE UNIQUE INDEX contract_events_id_key ON contract_events (id);
CREATE INDEX contract_events_rejected_idx
  ON contract_events (ledger) WHERE status = 'rejected';

-- 3. Create the default partition plus partitions covering existing rows.
CREATE TABLE contract_events_default PARTITION OF contract_events DEFAULT;
-- Repeat for each range present in the old table, e.g.:
CREATE TABLE contract_events_p0 PARTITION OF contract_events
  FOR VALUES FROM (0) TO (1000000);

-- 4. Copy the data. Rows outside any created range land in the default partition.
INSERT INTO contract_events (id, ledger, tx_hash, topic, payload, status, error, created_at)
SELECT id, ledger, tx_hash, topic, payload, status, error, created_at
FROM contract_events_old;

COMMIT;
```

Verify row counts match (`SELECT count(*) FROM contract_events_old;` vs the new table),
then drop the old table:

```sql
DROP TABLE contract_events_old;
```

If any rows landed in `contract_events_default`, create the missing range partitions and
move them:

```sql
BEGIN;
CREATE TABLE contract_events_pN PARTITION OF contract_events
  FOR VALUES FROM (<lo>) TO (<hi>);
WITH moved AS (
  DELETE FROM contract_events_default RETURNING *
)
INSERT INTO contract_events SELECT * FROM moved;
COMMIT;
```

Restart the indexer; it resumes from its cursor and creates future partitions
automatically. To archive old data later, `DETACH` and drop whole partitions instead of
running large `DELETE`s.

## IPFS

- `POST /upload` calls Kubo's `/api/v0/add?pin=true&cid-version=1` at `IPFS_API_URL`, with a
  timeout of `IPFS_TIMEOUT_MS`. An unreachable node returns `502`, a timeout `504`.
- The Kubo RPC API is an admin interface: never expose port 5001 publicly. Compose binds it to
  `127.0.0.1`.
- Pins live on that one node. For durability, run a pinning service or cluster. A pluggable
  pinning-provider interface is a tracked issue.
- Check a node: `docker compose exec ipfs ipfs id`. List pins:
  `docker compose exec ipfs ipfs pin ls --type=recursive`.

## Shutdown

Both processes handle SIGTERM/SIGINT. The API stops accepting connections and closes the
pool. The indexer finishes the in-flight page (one transaction) and stops. Either exits
non-zero after `SHUTDOWN_TIMEOUT_MS`. An interrupted page is rolled back and re-read on the
next start.
