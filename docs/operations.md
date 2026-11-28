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

### Composition root

Configuration and I/O are wired up explicitly in `src/container.ts`, the composition root.
It reads the environment once, builds the config, the Postgres pool, the RPC client and the
services, and passes them to `createApp(deps)` / `createIndexer(deps)`. Services are
factories that take their dependencies (e.g. `createFolderService({ db })`).

Only the entrypoints (`src/server.ts`, `src/indexer/main.ts` and the CLI) read env and start
I/O. Every other module under `src/` can be imported with an empty environment, which is
what the tests rely on: they build the app with explicit dependencies instead of mutating
`process.env`. If you need configuration in a new module, take it as a parameter rather
than calling `getEnv()` — a test enforces that `getEnv()` is only called from the
composition root and entrypoints.

## Health

- **API**: `GET /health` returns `200` when Postgres answers, `503` otherwise, and includes
  the indexer's status ([api.md](api.md#get-health)). The image's `HEALTHCHECK` uses it.
- **Indexer**: the indexer process runs a small embedded HTTP server on
  `INDEXER_HTTP_PORT` (default `9464`) with two endpoints. Probes are a single in-process
  HTTP request: no Node/ts-node startup, no database connection.
  - `GET /healthz` — `200` while the poll loop is alive and the last tick finished within
    `INDEXER_HEALTH_TICK_WINDOW × INDEXER_POLL_INTERVAL_MS` (default window `3`). A stuck
    tick makes it return `503` within that window. It does not depend on the database.
  - `GET /readyz` — `200` when the last successful page was within
    `INDEXER_STALE_AFTER_MS` and the indexer is not halted (retention gap); `503`
    otherwise.
  - Both return JSON in-memory state:

```json
{
  "status": "ok",
  "halted": false,
  "lastTickAt": "2026-11-10T07:37:30.225Z",
  "lastSuccessAt": "2026-11-10T07:37:30.225Z",
  "currentPage": { "from": "5654242", "to": "5654299" },
  "failures": 0,
  "backoffMs": 0
}
```

  docker-compose and the Dockerfile `HEALTHCHECK` for the indexer service probe `/healthz`
  on this port. Set `INDEXER_HTTP_PORT=0` to disable the server (e.g. when running the
  indexer as a library).
- **CLI**: `npm run indexer -- healthcheck` (or `node dist/indexer/cli.js healthcheck` in
  the image) is kept for manual use. It exits `1` if the indexer hasn't completed a poll
  within `INDEXER_STALE_AFTER_MS`. It is expensive (starts a process and opens a DB
  connection), so don't use it as a container healthcheck.
- **State**: `npm run indexer -- status` prints `indexer_state`:

```json
{
  "cursor": "0024284788768636927-4294967295",
  "last_ledger": "5654242",
  "last_success_at": "2026-11-10T07:37:30.225Z",
  "status": "ok"
}
```

`npm run indexer -- status` also lists entries whose on-chain storage is archived or close
to expiry. Soroban persistent entries (folder claims, template registrations, portfolio
data) have a TTL and are archived when it lapses unless extended; events don't announce
archival, so the indexer tracks it separately:

```json
{
  "cursor": "0024284788768636927-4294967295",
  "last_ledger": "5654242",
  "last_success_at": "2026-11-10T07:37:30.225Z",
  "status": "ok",
  "archival": {
    "checked_at": "2026-11-10T07:37:31.004Z",
    "soon_to_expire": [
      { "entity": "folder", "id": "42", "live_until_ledger": "5655000" }
    ],
    "archived": [{ "entity": "portfolio", "id": "7", "live_until_ledger": "5650000" }]
  }
}
```

API responses carry the same information per entity as
`archival: { liveUntilLedger, archived }` ([api.md](api.md)). An archived entity must be
restored on-chain before the contract can use it; transactions against it fail until then.

TTL tracking queries `getLedgerEntries` for the storage keys behind recently active
entities, in batches bounded by `TTL_BATCH_SIZE` and at most once per `TTL_CHECK_INTERVAL_MS`,
so RPC usage stays within the configured limits. Archived entries are re-checked less often
than active ones. If the status output shows `archival.checked_at` going stale, the TTL
tracker is failing; check the logs for `TTL check failed`.

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

- `/health` `indexer.stale` is `true`, or `indexer.status` is `retention_gap` or `cursor_invalid`
- `Indexer poll failed` logged repeatedly (the `failures` count grows)
- rows in `contract_events` with `status = 'rejected'`
- rows in `contract_events` with `status = 'orphaned'` (an UPDATE-type event whose parent row
  has not arrived yet; `npm run indexer -- orphans` prints them as JSON). They are re-applied
  automatically once the parent row is indexed.

## Doctor

`npm run doctor` diagnoses configuration and dependencies end to end. It runs each check
with a timing and prints a table:

```text
CHECK              STATUS  TIME    DETAIL
env                ok      3ms     12 variables, network testnet
database           ok      18ms   connected, schema v3, role folder
rpc                ok      142ms  version 21.0.0, passphrase matches
contract           ok      96ms   found, retention window 120960 ledgers
kubo               ok      11ms   version 0.29.0, auth ok
indexer            warn    4ms    lag 42 ledgers, status ok, 0 open gaps, 2 rejected events
```

- `--json` prints a stable machine-readable document (one object per check with `name`,
  `status` (`ok`/`warn`/`fail`), `durationMs`, `detail` and optional `hint`), suitable for
  bug reports and scripts.
- Exit codes: `0` when every check is `ok` or `warn`, `1` when any check is `fail`.
- A failing check prints a `hint` naming the likely cause (wrong `STELLAR_NETWORK_PASSPHRASE`,
  missing contract, unreachable Kubo, stale indexer, ...).
- Secrets are never printed: RPC and IPFS URLs are redacted (credentials and query strings
  removed) and keys/passwords are omitted.

Run it before filing a bug and paste the `--json` output into the report template.

## Canary

`.github/workflows/canary.yml` runs every 30 minutes (configurable via the workflow's
`schedule` and `CANARY_INTERVAL_MINUTES`) against testnet. `scripts/canary.ts`:

1. Funds a throwaway account with Friendbot.
2. Performs a cheap contract action (`set_user_template`), recording the submitted ledger.
3. Polls `CANARY_API_URL` with `minLedger` until the change is visible.

It reports latency for each stage (submit → ledger close → API visible) in the job summary
and fails when the total exceeds `CANARY_THRESHOLD_MS` (default `120000`). Optionally set
`CANARY_METRICS_URL` to push the result to a metrics endpoint. No secrets are required
beyond the optional API URL.

Cleanup: the throwaway account holds only testnet XLM and the template it sets is
overwritten on the next run, so no persistent state accumulates. Friendbot rate limits are
avoided by the 30-minute interval; don't run the canary more often than every 10 minutes.
Run it locally with `npm run canary -- --dry-run` against the compose stack.

## End-to-end tests

`npm run test:e2e` starts a local `stellar/quickstart` network with RPC, deploys the pinned
Folder contract wasm (verified by sha256), runs the scripted scenario (init, admins,
templates, folders, mint, update, set template, including a multi-page scenario) and asserts
the API read model. The same script runs in CI on every PR. Bump the contract version in one
place (`scripts/e2e/config.ts`).

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
   now and in future, recording the gap in `index_gaps` (and `indexer_state.last_gap`).

   The indexer resumes at the RPC's `oldestLedger` itself, not `oldestLedger + 1`:
   `getEvents` treats `startLedger` as inclusive, so the oldest retained ledger is
   still indexed. `last_gap` records the exact missing range
   (`missedFrom`..`missedTo`) and the ledger it actually resumed at (`resumedAt`).
   If the retention window moves forward while resuming, it retries from the new
   `oldestLedger`, bounded by `INDEXER_MAX_GAP_RESUME_ATTEMPTS` (default 5).

   Every gap is also a row in `index_gaps` (`reason`, `missed_from`, `missed_to`,
   `resumed_at`, `detected_at`, nullable `filled_at`), written in the same
   transaction as the resume. `reason` is `retention` for a skipped cursor,
   `config` when `INDEXER_START_LEDGER` is older than the window, and `manual`
   for operator-recorded gaps. Ranges never overlap: a new range that starts at
   or before the newest row's `missed_to` is merged into it. `last_gap` is always
   derived from the newest row. List them with:

   ```bash
   npm run indexer -- gaps          # all gaps, newest first, as JSON
   npm run indexer -- gaps --open   # only gaps with filled_at IS NULL
   ```

   Once a range has been backfilled, mark it filled:

   ```bash
   npm run indexer -- fill-gap <id>
   # or: UPDATE index_gaps SET filled_at = NOW() WHERE id = <id>;
   ```
2. **Rebuild from an RPC with longer retention.** Point `STELLAR_RPC_URL` at an RPC that
   still has the missing ledgers (self-hosted with a larger retention window, or a provider
   with history), run `reset-cursor` to the first missing ledger, and let it catch up. Then
   switch back if you like.
3. **Backfill from archives.** Not implemented yet (tracked as a GitHub issue). It would
   read the missing ledgers from history archives or Galexie data.

On an empty database the indexer never halts: an `INDEXER_START_LEDGER` older than the window
is clamped to the oldest retained ledger with a warning.

### Invalid cursor

The saved cursor is validated on every read. If it is corrupt (not a `<TOID>-<op>` paging
cursor) the indexer recovers on its own when `last_ledger` is valid: it clears the cursor,
resumes from `last_ledger` (already-stored events are skipped, so nothing is missed) and
records `indexer_state.cursor_recovered` (`{ invalidCursor, resumedAt, at }`, also shown as
`indexer.cursorRecovered` in `/health`).

If `last_ledger` is missing or invalid too, the indexer halts:

```text
ERROR Indexer halted: invalid cursor {"error":"Saved cursor \"garbage\" is not a valid RPC paging cursor ..."}
```

`/health` then shows `"indexer": {"status": "cursor_invalid", ...}`. Recover with:

```bash
npm run indexer -- reset-cursor <ledger to resume from>
# in the container image:
docker compose exec indexer node dist/indexer/cli.js reset-cursor <ledger>
```

### Re-index from a ledger

`reset-cursor` is safe at any time because events are deduplicated by id. Rewinding
re-reads events and skips the ones already stored. To rebuild the read model from scratch:

```sql
TRUNCATE contract_events, folders, templates, portfolios, admins, indexer_state;
```

```bash
npm run indexer -- reset-cursor <first ledger to index>   # or leave state empty to use INDEXER_START_LEDGER
```

### Retry rejected events

Events the indexer could not decode (or the database refused) are stored with
`status = 'rejected'` and their raw XDR. After fixing the decoder, re-decode them:

```bash
npm run indexer -- retry-rejected [--topic <t>] [--since-ledger <n>] [--dry-run]
```

- `--topic` limits the run to one event topic (e.g. `port_mint`).
- `--since-ledger` limits the run to events at or after that ledger.
- `--dry-run` prints what would change without writing anything.

Events are retried in ledger/TOID order, each applied under a savepoint, and
`status`, `data`, `error`, `retry_count` and `last_retry_at` are updated. The
command takes the indexer advisory lock, so stop the indexer process first (it
holds the lock while running). It is idempotent: events that still fail stay
rejected, and applied events are no longer selected.

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

## Feature flags

Some behaviour can be toggled at runtime without redeploying, for incident response. Flags
live in the `feature_flags` table (`key`, `enabled`, `updated_by`, `updated_at`, `note`).
The API and indexer read them with a short cache TTL (`FEATURE_FLAGS_CACHE_TTL_MS`, default
a few seconds), so a change takes effect across all replicas within that TTL. Where the
database supports it, a `NOTIFY` invalidates the cache immediately.

Gated features: uploads, bundle uploads, webhook delivery, SSE and GraphQL. When a flag is
disabled the endpoint returns `503` with a clear message naming the flag, so clients can
retry later.

List and set flags with the CLI:

```bash
npm run flags -- list
npm run flags -- set uploads false --by alice --note "Kubo overloaded"
npm run flags -- set uploads true --by alice
# in the container image (no ts-node there):
docker compose exec api node dist/cli/flags.js list
```

Every change is audited: `updated_by`, `updated_at` and `note` are stored on the row, and
the CLI logs the change. Prefer setting a `note` explaining why during an incident, and
re-enable the flag once the incident is over.

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
- Pins live on that one node. For durability, run a pinning service or cluster. A pluggable
  pinning-provider interface is a tracked issue.
- Check a node: `docker compose exec ipfs ipfs id`. List pins:
  `docker compose exec ipfs ipfs pin ls --type=recursive`.
- Run `npm run ipfs -- reconcile` to immediately check and repair all portfolio/template CIDs.
- Run `npm run ipfs -- gc --older-than 7d --dry-run` before unpinning unreferenced uploads;
  omit `--dry-run` to apply the pin removals. CIDs referenced on-chain are never GC'd.

## Network fault injection (chaos profile)

To reproduce production network conditions locally, an optional compose profile puts
[Toxiproxy](https://github.com/Shopify/toxiproxy) in front of Postgres, Kubo and the RPC:

```bash
docker compose --profile chaos up
```

With the profile enabled, the API and indexer connect through the proxies instead of the
upstreams directly:

| Proxy      | Listen (in compose network) | Upstream            | Used by                       |
| ---------- | --------------------------- | ------------------- | ----------------------------- |
| `postgres` | `toxiproxy:8666`            | `postgres:5432`     | API and indexer (`DATABASE_URL`) |
| `kubo`     | `toxiproxy:8667`            | `ipfs:5001`         | API (`IPFS_API_URL`)          |
| `rpc`      | `toxiproxy:8668`            | `STELLAR_RPC_URL`   | indexer (`STELLAR_RPC_URL`)   |

The Toxiproxy admin API is on `127.0.0.1:8474`. Without the profile the stack behaves as
before and connects to the upstreams directly.

Scripts live in `scripts/chaos/`:

- `apply.sh <proxy> <toxic> [args...]` adds a toxic to a proxy.
- `restore.sh [proxy]` removes all toxics (all proxies if none is given).
- `smoke.sh` verifies that every proxy routes traffic to its upstream.

### Recipes

Each recipe lists the command and the behaviour you should observe.

**RPC 5 s latency** — indexer polls slow down and logs timeouts/backoff.

```bash
scripts/chaos/apply.sh rpc latency --latency 5000 --jitter 0
```

Expected: each RPC call takes about 5 s. Polls take longer, and once a call exceeds the
client timeout the indexer logs `Indexer poll failed` and backs off exponentially (up to
`INDEXER_MAX_BACKOFF_MS`). `/health` stays `200` while Postgres answers; the indexer's
`last_success_at` stops advancing. Restore with `scripts/chaos/restore.sh rpc`.

**Postgres drops connections** — indexer retries, no partial writes, cursor unchanged.

```bash
scripts/chaos/apply.sh postgres reset_peer --timeout 0
```

Expected: in-flight connections are reset. The API returns `503` from `/health` while the
database is unreachable. The indexer retries with backoff; the interrupted page is rolled
back, so no partial writes land and `indexer_state.cursor` does not move until a poll
succeeds. Restore with `scripts/chaos/restore.sh postgres`.

**Kubo slow upload** — `POST /upload` returns `504` after `IPFS_TIMEOUT_MS`.

```bash
scripts/chaos/apply.sh kubo latency --latency 30000 --jitter 0
```

Expected: uploads take longer than `IPFS_TIMEOUT_MS` (default 10 s), so `POST /upload`
returns `504`. With a latency below the timeout the upload succeeds but slowly. Restore
with `scripts/chaos/restore.sh kubo`.

Other useful toxics: `bandwidth` (`--rate <KB/s>`) to throttle a proxy, `timeout` to stop
forwarding traffic, and `reset_peer` to drop connections. Run `scripts/chaos/smoke.sh` after
starting the profile to confirm the proxies route traffic.

## Shutdown
=======

Both processes handle SIGTERM/SIGINT. The API stops accepting connections and closes the
pool. The indexer finishes the in-flight page (one transaction) and stops. Either exits
non-zero after `SHUTDOWN_TIMEOUT_MS`. An interrupted page is rolled back and re-read on the
next start.

### Init process (PID 1)

The image runs Node under `tini` as the entrypoint, so Node is not PID 1. `tini` forwards
signals to Node and reaps orphaned/zombie child processes (healthcheck commands, future
tools). Without it, signals sent before Node registers its handlers are ignored and
`docker stop` falls back to SIGKILL after the timeout.

`docker stop` on both the API and indexer containers should complete gracefully (exit 0)
well before the kill timeout. A CI smoke step starts the container, sends SIGTERM and
asserts the exit code and duration.

### Kubernetes

- Keep `tini` as the entrypoint; don't override `command`/`args` with a bare `node ...`
  unless you also set `shareProcessNamespace: true` (or run under an init in the pod).
- Set `terminationGracePeriodSeconds` comfortably above `SHUTDOWN_TIMEOUT_MS` (e.g. 30s
  with a 10s shutdown timeout) so the graceful path finishes before SIGKILL.
- The pod's `preStop` hook is not required, but if you add one keep it shorter than the
  grace period.
- Healthcheck commands run as children of the container process; `tini` reaps them, so
  repeated probes don't accumulate zombies.
