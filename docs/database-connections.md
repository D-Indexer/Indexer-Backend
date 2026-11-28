# Database connections and PgBouncer

Managed Postgres is usually fronted by PgBouncer in **transaction mode**: a
client gets a server connection only for the length of one transaction, then
it goes back to the pool for other clients to use. Anything that keeps state
on the session (the server connection) breaks in that mode. It can vanish
between statements, or worse, leak to an unrelated client.

This document lists every database connection in the codebase and says which
URL it must use.

## The two URLs

| Variable              | Points at                                | Used for                                         |
| --------------------- | ---------------------------------------- | ------------------------------------------------ |
| `DATABASE_URL`        | the pooler (PgBouncer, transaction mode) | everything that is transaction-safe (the default) |
| `DATABASE_DIRECT_URL` | Postgres directly, bypassing the pooler  | session-required connections (see below)         |

`DATABASE_DIRECT_URL` is optional. When it is unset, `getDirectDatabaseUrl()`
in `src/config/env.ts` falls back to `DATABASE_URL`, so deployments without a
pooler need no change.

Keep the number of direct connections small and fixed: one per LISTEN
channel per process, one for the indexer lock, and short-lived ones for
migrations.

## What breaks in transaction mode

| Pattern                                           | Why it breaks                                                             | Use instead                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `LISTEN`                                          | the subscription lives on a server connection the client no longer holds | a dedicated `pg.Client` on `DATABASE_DIRECT_URL`                            |
| `pg_advisory_lock` / `pg_try_advisory_lock`       | the lock is held by a shared server connection                            | `pg_advisory_xact_lock` inside a transaction, or a direct connection        |
| `SET ...` / `set_config(..., false)`              | the setting leaks to whichever client gets that server connection next   | `SET LOCAL ...` / `set_config(..., true)` inside `BEGIN ... COMMIT`         |
| Named prepared statements (`{ name: '...' }` in `pg`) | the statement exists only on one server connection                     | unnamed statements (the `pg` default). PgBouncer ≥ 1.21 with `max_prepared_statements` also works |
| Temp tables or `WITH HOLD` cursors that span transactions | session-scoped                                                    | keep them inside one transaction                                            |

These are transaction-safe: single queries, `BEGIN ... COMMIT` on one
checked-out `PoolClient`, `SELECT ... FOR UPDATE [SKIP LOCKED]`,
`pg_notify(...)` (delivered on commit), and parameterised queries (`pg` uses
the unnamed prepared statement).

## Audit

### Session-required: must use `DATABASE_DIRECT_URL`

| Where                                                      | What                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/db/client.ts`: `connectListener`                      | `LISTEN cache_invalidate` for cache invalidation                            |
| `src/db/listen.ts`: `subscribeIndexed`                     | `LISTEN folder_indexed`. Defaults to `DATABASE_DIRECT_URL`; callers can override `connectionString` |
| `src/featureFlags.ts`: `listener` option                   | `LISTEN` for flag invalidation. Callers must pass a dedicated direct `Client` |
| `src/indexer/main.ts`: indexer lock (`tryLockIndexer`)     | process-lifetime session lock. Runs on a dedicated direct `Client`          |
| `src/indexer/main.ts`: `migrate()` at startup              | schema DDL. Runs on a short-lived direct pool                               |
| `src/db/migrate.ts` (`npm run db:migrate`)                 | schema DDL. Runs on a direct pool                                           |
| `src/__tests__/testUtils.ts`: `setupWorkerSchema` / `teardownWorkerSchema` | test DDL. Uses `TEST_DATABASE_DIRECT_URL` / `DATABASE_DIRECT_URL` when set |

### Transaction-safe: pooled `DATABASE_URL`

| Where                                                    | Notes                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/container.ts` main pool (API, services)             | single queries                                                        |
| `src/indexer/stellar.ts`: `processPageInContext`, `recordGap` | `BEGIN ... COMMIT` on one client, `FOR UPDATE`                    |
| `src/jobs/runner.ts`: `claimOne` and status updates      | `FOR UPDATE SKIP LOCKED` inside one transaction, leases are rows      |
| `src/middleware/idempotency.ts`                          | single queries                                                        |
| `src/db/client.ts`: `publishCacheInvalidation`           | `pg_notify` is transaction-safe                                       |
| `src/featureFlags.ts`: flag writes and `pg_notify`       | single queries                                                        |
| `src/cli/*` (`abuse`, `flags`, `moderation`, `webhooks`, `doctor`) | single queries                                              |

### Known caveat: the test harness

`createWorkerPool()` in `src/__tests__/testUtils.ts` picks the per-worker schema
with a session-level `SET search_path` on each new connection. That doesn't
stick through PgBouncer in transaction mode. The `pgbouncer` CI job works
around it by setting the schema as a role default
(`ALTER ROLE folder IN DATABASE folder_test SET search_path = test_1, public`),
which PgBouncer's server connections pick up at login. This is possible
because `npm test` runs `--runInBand`, so there is only one worker.

## Rules for new code

1. Default to the pooled `DATABASE_URL` (the container's pool).
2. Don't use session `SET`. Use `SET LOCAL` (or `set_config(name, value, true)`)
   inside an explicit transaction on one `PoolClient`.
3. Need a lock? Prefer `pg_advisory_xact_lock` inside a transaction, or a row
   lock. If the lock has to outlive a transaction, open a dedicated `pg.Client`
   on `getDirectDatabaseUrl(env)` and add it to the audit above.
4. Need `LISTEN`? Use a dedicated `pg.Client` on `getDirectDatabaseUrl(env)`
   with reconnect handling (see `src/db/listen.ts`), and add it to the audit.
5. Don't pass `name:` to `pg` queries (named prepared statements).

## Testing through PgBouncer

- **CI:** the `pgbouncer` job in `.github/workflows/ci.yml` runs `npm test` with
  `TEST_DATABASE_URL` pointing at PgBouncer (transaction mode, pool size 3) and
  `TEST_DATABASE_DIRECT_URL` pointing at Postgres.
- **Locally:** `docker compose --profile pgbouncer up -d postgres pgbouncer`, then

  ```sh
  TEST_DATABASE_URL=postgresql://folder:folder@localhost:6432/folder \
  TEST_DATABASE_DIRECT_URL=postgresql://folder:folder@localhost:5432/folder \
  npm test
  ```

  Set the role-default `search_path` first, as described in the test-harness
  caveat above.
