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
- Pins live on that one node. For durability, run a pinning service or cluster. A pluggable
  pinning-provider interface is a tracked issue.
- Check a node: `docker compose exec ipfs ipfs id`. List pins:
  `docker compose exec ipfs ipfs pin ls --type=recursive`.

### Kubo RPC network boundary

The Kubo RPC API (`:5001`) is an admin interface: it can pin/unpin, rewrite config, manage
keys and shut the node down. Treat it as a private control plane, not a public endpoint.

**Production topology.** Only the API (and the indexer, if it ever needs to pin) may reach
port 5001. Put Kubo on a dedicated internal network that no other service and no ingress
joins, and never publish 5001 on a host interface:

- Compose: Kubo is bound to `127.0.0.1` and shares an internal network with the API only.
  Do not add `ports:` for 5001, and do not attach unrelated services to that network.
- Kubernetes/other orchestrators: a `ClusterIP` service (no `NodePort`/`LoadBalancer`), a
  `NetworkPolicy` allowing ingress to 5001 only from the API's pods, and no ingress route.
- Never expose 5001 through a reverse proxy, tunnel or public load balancer.

**Authentication.** Kubo ≥ 0.25 supports `API.Authorizations`, which scopes a secret to a set
of RPC paths. Configure one entry for the API and give the API the same secret via
`IPFS_API_AUTH` (or `IPFS_API_AUTH_FILE` to read it from a file/mounted secret). The API
sends it as `Authorization: Bearer <secret>` on every RPC call. Compose wires this up for
you; in production, generate the secret with a CSPRNG and store it in your secret manager.

**Allowed paths.** Restrict the authorization to the RPC paths the service actually uses:

- `/api/v0/add`
- `/api/v0/pin/*`
- `/api/v0/version`
- `/api/v0/dag/import`

Anything else (config, key, shutdown, repo) is rejected by Kubo even with a valid secret.

**Startup check.** On boot the API probes Kubo with an unauthenticated request. If Kubo
answers, it logs a warning (`Kubo RPC accepts unauthenticated requests`) because the
authorization isn't enforced. Treat that warning as a misconfiguration: check that
`API.Authorizations` is set in Kubo's config and that `IPFS_API_AUTH`/`IPFS_API_AUTH_FILE`
matches it. Unauthenticated requests must be rejected (`401`/`403`) in production.

## Verifying published images

Images published from `main` and tags are signed with keyless [Sigstore
cosign](https://docs.sigstore.dev/) using the CI workflow's GitHub OIDC identity, and carry
an SBOM attestation and SLSA provenance. PR builds produce an SBOM artifact but are not
signed or published.

Verify a signature (replace the image reference with the one you run):

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/<org>/<repo>/.github/workflows/.*@refs/(heads/main|tags/.*)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<org>/<repo>:<tag>
```

Inspect the SBOM attestation (CycloneDX, generated by Syft) and the SLSA provenance:

```bash
cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp '^https://github.com/<org>/<repo>/.github/workflows/.*@refs/(heads/main|tags/.*)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<org>/<repo>:<tag> | jq -r '.payload' | base64 -d | jq .

cosign verify-attestation --type slsaprovenance \
  --certificate-identity-regexp '^https://github.com/<org>/<repo>/.github/workflows/.*@refs/(heads/main|tags/.*)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<org>/<repo>:<tag>
```

The SBOM is also attached to the workflow run as a build artifact, which is handy when
responding to a newly disclosed CVE: download it, find the affected package, and rebuild.
Pin the identity regexp to your repository and workflow so a signature from anywhere else
fails verification.

## Shutdown

Both processes handle SIGTERM/SIGINT. The API stops accepting connections and closes the
pool. The indexer finishes the in-flight page (one transaction) and stops. Either exits
non-zero after `SHUTDOWN_TIMEOUT_MS`. An interrupted page is rolled back and re-read on the
next start.
