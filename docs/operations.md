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

## Container memory and the Node heap

The image runs `deploy/entrypoint.sh`, which sizes V8's old-space heap from the container's
memory limit before starting the process. It reads the cgroup v2 limit
(`/sys/fs/cgroup/memory.max`) or the v1 limit (`/sys/fs/cgroup/memory/memory.limit_in_bytes`)
and sets `--max-old-space-size` to about 75% of it, leaving headroom for the rest of the
process (buffers, native allocations, IPFS response bodies). Without this, older Node
versions size the heap from host memory and the kernel OOM-kills the container before V8
collects, producing abrupt restarts with no useful logs.

- The effective limit is logged at startup, e.g.
  `INFO Node heap limit {"maxOldSpaceSizeMb":384,"source":"cgroup","limitMb":512}`.
  `source` is `cgroup` when derived from the limit, `default` when no limit was found.
- An explicit `NODE_OPTIONS=--max-old-space-size=<MB>` is respected and the entrypoint
  leaves it untouched (logged with `source: "env"`). Use this to override the calculation.
- `--max-old-space-size` only bounds the old generation; total RSS is higher. Keep the
  container limit comfortably above the logged heap value.

Recommended limits:

| Process | Limit        | Notes                                                                 |
| ------- | ------------ | --------------------------------------------------------------------- |
| API     | 512 MB–1 GB  | Scale with `REQUEST_BODY_LIMIT` and concurrent uploads. Each buffered upload holds the body in memory, so budget roughly `REQUEST_BODY_LIMIT × concurrent uploads` on top of the base heap. |
| Indexer | 256–512 MB   | Pages are bounded by `INDEXER_PAGE_SIZE`; 256 MB is enough for the default. |

With a 512 MB limit the API gets a ~384 MB heap, leaving ~128 MB for buffers and native
memory. If you raise `REQUEST_BODY_LIMIT` or expect many simultaneous uploads, raise the
container limit rather than the heap fraction.

### Smoke test

Assert the logged heap value under a 512 MB limit:

```bash
docker build -f deploy/Dockerfile -t folder-api .
docker run --rm --memory=512m folder-api 2>&1 | grep 'Node heap limit'
# expect maxOldSpaceSizeMb below 512 (about 384) and source "cgroup"
```

To confirm an override is respected:

```bash
docker run --rm --memory=512m -e NODE_OPTIONS=--max-old-space-size=256 folder-api 2>&1 | grep 'Node heap limit'
# expect maxOldSpaceSizeMb 256 and source "env"
```

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
