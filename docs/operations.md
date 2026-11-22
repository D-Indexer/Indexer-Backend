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

## Load shedding and timeouts

### HTTP server timeouts (#190)

The API configures four Node.js `http.Server` properties at startup:

| Property               | Env var                          | Default | Purpose                                                                        |
| ---------------------- | -------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `headersTimeout`       | `SERVER_HEADERS_TIMEOUT_MS`      | 60 000  | Drops connections that never finish sending headers (slowloris defence)        |
| `requestTimeout`       | `SERVER_REQUEST_TIMEOUT_MS`      | 300 000 | Aborts stalled upload bodies and releases their memory buffers                 |
| `keepAliveTimeout`     | `SERVER_KEEP_ALIVE_TIMEOUT_MS`   | 65 000  | Must exceed your load balancer's idle timeout to avoid 502s on reused sockets  |
| `maxRequestsPerSocket` | `SERVER_MAX_REQUESTS_PER_SOCKET` | 0       | `0` = unlimited; set > 0 to drain connections gradually during rolling deploys |

**Matching your load balancer**: set `SERVER_KEEP_ALIVE_TIMEOUT_MS` to at least
LB idle timeout + 1 000 ms. AWS ALB default is 60 000 ms, so the 65 000 ms default
is safe. GCP defaults to 600 000 ms — raise this variable accordingly.

### DB pool load shedding (#187)

When all pool connections are busy, `pg.Pool` queues requests internally. Once
`waitingCount` exceeds `DB_POOL_SHED_THRESHOLD` (default `2`), new requests receive
`503 Service Unavailable` with a `Retry-After` header immediately rather than
waiting up to `DB_CONNECTION_TIMEOUT_MS` and returning a 500.

Pool acquisition timeouts that do slip through are also mapped to 503 (not 500) in the
error handler, so clients and CDNs can distinguish back-pressure from bugs.

Tune `DB_POOL_SHED_THRESHOLD` relative to `DB_MAX_CONNECTIONS`. A value of `2` works for
pools of 10; raise it proportionally for larger pools.

### Event-loop lag shedding (#188)

CPU-intensive work (multipart parsing, content sniffing) can delay the event loop and
make cheap read endpoints appear slow. When the p99 event-loop lag measured over the
last second exceeds `OVERLOAD_LAG_THRESHOLD_MS` (default `100 ms`), all non-health
requests return `503` with `Retry-After`.

`GET /health` and `GET /health/live` are always exempt so orchestrators (Kubernetes,
ECS) never restart a healthy-but-busy pod.

### Per-route deadlines (#188)

Each route family has a hard deadline enforced by the `withDeadline` middleware:

| Route prefix                            | Env var                   | Default | Timeout status |
| --------------------------------------- | ------------------------- | ------- | -------------- |
| `/folders`, `/templates`, `/portfolios` | `ROUTE_TIMEOUT_READ_MS`   | 5 000   | 503            |
| `/upload`                               | `ROUTE_TIMEOUT_UPLOAD_MS` | 60 000  | 504            |

When a deadline fires, the response is ended immediately and an `AbortSignal` is set on
`req.abortSignal` so downstream `fetch` or database calls can be cancelled.
