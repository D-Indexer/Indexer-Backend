# Operations

## Local Runbook

1. Start PostgreSQL.
2. Start Kubo/IPFS if upload behavior is needed locally.
3. Copy `.env.example` to `.env`.
4. Fill in the Folder contract ID.
5. Run migrations.
6. Start the service.

```bash
npm install
npm run db:migrate
npm run dev
```

## Health Checks

Use:

```bash
curl http://localhost:3000/health
```

Expected healthy state:

- HTTP status `200`
- `status` is `ok`
- `db` is `ok`
- `indexer.cursor` is either `null` before events are indexed or a string ledger cursor

## Graceful Shutdown

The server handles `SIGTERM` and `SIGINT`.

Shutdown sequence:

1. stop scheduling new indexer polls
2. close the HTTP server
3. close the PostgreSQL pool
4. exit the process

`SHUTDOWN_TIMEOUT_MS` controls the maximum shutdown wait.

## Rebuilding the Read Model

PostgreSQL is a read cache. To rebuild:

1. stop the service
2. restore or recreate the database
3. run `npm run db:migrate`
4. set `indexer_state.indexer_cursor` to the ledger to replay from, or leave it empty to start from default behavior
5. restart the service

## Common Failure Modes

| Symptom | Likely cause | Check |
| ------- | ------------ | ----- |
| `/health` returns `503` | database unavailable | `DATABASE_URL`, PostgreSQL status |
| indexer logs repeated failures | RPC or contract config issue | `STELLAR_RPC_URL`, `FOLDER_CONTRACT_ID` |
| uploads fail | IPFS RPC unavailable | `IPFS_API_URL`, Kubo daemon |
| CORS failures | missing frontend origin | `CORS_ORIGIN` |

## Runtime Import Check

CI verifies that the compiled production app can be imported with Node after `npm run build`. This catches CommonJS/ESM runtime mismatches before deployment.
