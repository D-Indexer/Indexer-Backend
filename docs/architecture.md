# Architecture

D-Indexer-Backend is a TypeScript/Node.js service with three responsibilities:

1. Poll Soroban RPC for Folder contract events.
2. Maintain a PostgreSQL read model.
3. Serve the Folder frontend through REST endpoints.

## Runtime Components

```text
Soroban RPC
    |
    v
src/indexer/stellar.ts
    |
    v
PostgreSQL <---- src/services/* <---- src/controllers/* <---- Express routes
    ^
    |
IPFS uploads are pinned through src/services/ipfs.ts
```

## Source of Truth

The Folder contract is the durable source of truth. PostgreSQL is intentionally a rebuildable cache. If the database needs to be rebuilt, run migrations and replay events from the desired cursor.

## App Startup

`src/server.ts` is responsible for process-level behavior:

- loading environment configuration
- creating the Express app
- starting the HTTP server
- starting the indexer
- handling graceful shutdown

`src/app.ts` is isolated so tests can create the Express app without opening a listening socket.

## Request Flow

1. Request enters Express.
2. `requestId` assigns or propagates `x-request-id`.
3. security headers are attached.
4. CORS and JSON parsing run.
5. route handlers validate inputs with Zod.
6. service modules query PostgreSQL or IPFS.
7. errors are normalized by `errorHandler`.

## Indexer Flow

1. Load the last cursor from `indexer_state`.
2. Call Soroban RPC `getEvents`.
3. Ignore events from other contracts.
4. Decode event topics from XDR.
5. Upsert the appropriate PostgreSQL row.
6. Save the next cursor after processing a batch.

The poll interval is configured by `INDEXER_POLL_INTERVAL_MS`.
