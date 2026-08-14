# ADR 0008: Graceful Shutdown

## Decision

Handle `SIGTERM` and `SIGINT` by stopping the indexer, closing HTTP, and ending the database pool.

## Rationale

Deployments need predictable shutdown behavior to avoid dropped requests and leaked database connections.

## Consequences

- server startup stays in `src/server.ts`
- the indexer exposes a `stop` method
- shutdown timeout is configurable
