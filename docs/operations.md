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

Logs are single lines (`<ISO time> <LEVEL> <message> <json context>`) on stdout/stderr.
`LOG_LEVEL=debug` adds more detail. RPC URLs in logs have credentials and query strings
removed.

What to alert on:

- `/health` `indexer.stale` is `true`, or `indexer.status` is `retention_gap`
- `Indexer poll failed` logged repeatedly (the `failures` count grows)
- rows in `contract_events` with `status = 'rejected'`

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
