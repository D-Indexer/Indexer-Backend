# Configuration

The API (`src/server.ts`) and the indexer (`src/indexer/main.ts`) read the same
environment variables. Both validate them with the Zod schema in
[`src/config/env.ts`](../src/config/env.ts) at startup and exit with a message
naming every invalid variable, for example:

```text
Invalid environment configuration: FOLDER_CONTRACT_ID: FOLDER_CONTRACT_ID is required
(testnet: CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV). See docs/configuration.md
```

Copy [`.env.example`](../.env.example) to `.env` for local runs; it is preset for testnet.

## Testnet values

| Variable                     | Value                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| `STELLAR_RPC_URL`            | `https://soroban-testnet.stellar.org`                                     |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015`                                       |
| `FOLDER_CONTRACT_ID`         | `CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV`                |
| `INDEXER_START_LEDGER`       | `5647760` (deployment ledger; only useful while the RPC still retains it) |

The contract ID comes from [`deployments/testnet.json`](https://github.com/D-Indexer/Indexer-Contract/blob/main/deployments/testnet.json)
in Indexer-Contract. Update it here and in `.env.example` when the contract is redeployed.

## Required

| Variable             | Validation                       | Purpose                                                                |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`       | non-empty                        | PostgreSQL connection string                                           |
| `STELLAR_RPC_URL`    | URL                              | Soroban RPC endpoint. Query strings (API keys) are redacted from logs. |
| `FOLDER_CONTRACT_ID` | contract strkey (`C…`, 56 chars) | Contract whose events are indexed                                      |
| `IPFS_API_URL`       | URL                              | Kubo RPC API used by `POST /upload`                                    |
| `IPFS_GATEWAY`       | URL                              | Public gateway base URL                                                |
| `CORS_ORIGIN`        | non-empty **in production only** | See below                                                              |

## Optional

| Variable                          | Default                     | Purpose                                                                                    |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `NODE_ENV`                        | `development`               | `development`, `test` or `production`                                                      |
| `PORT`                            | `3000`                      | API port                                                                                   |
| `CORS_ORIGIN`                     | any origin (non-production) | Comma-separated allow-list, or `*` for any origin. An unparseable list denies all origins. |
| `TRUST_PROXY`                     | `false`                     | Express `trust proxy`: `false`, a hop count, or comma-separated CIDRs. See below.          |
| `REQUEST_BODY_LIMIT`              | `1mb`                       | JSON body limit                                                                            |
| `LOG_LEVEL`                       | `info`                      | `debug`, `info`, `warn`, `error` or `silent`                                               |
| `STELLAR_NETWORK_PASSPHRASE`      | testnet passphrase          | Network passphrase (not used by the read-only indexer yet)                                 |
| `STELLAR_RPC_TIMEOUT_MS`          | `10000`                     | Per-request RPC timeout; failed requests are retried 3× with backoff                       |
| `INDEXER_POLL_INTERVAL_MS`        | `5000`                      | Delay between polls once caught up                                                         |
| `INDEXER_PAGE_LIMIT`              | `200`                       | Events per `getEvents` page (1–10000)                                                      |
| `INDEXER_START_LEDGER`            | unset                       | First ledger on an empty database. Unset = oldest ledger the RPC retains.                  |
| `INDEXER_ON_RETENTION_GAP`        | `halt`                      | `halt` or `skip`. See [operations](operations.md#retention-gap).                           |
| `INDEXER_MAX_BACKOFF_MS`          | `60000`                     | Cap for exponential backoff after failed polls                                             |
| `INDEXER_STALE_AFTER_MS`          | `120000`                    | Indexer counts as unhealthy after this long without a successful poll                      |
| `IPFS_TIMEOUT_MS`                 | `30000`                     | Timeout for the Kubo `add` call                                                            |
| `DB_MAX_CONNECTIONS`              | `10`                        | Pool size, per process                                                                     |
| `DB_IDLE_TIMEOUT_MS`              | `30000`                     | Pool idle timeout                                                                          |
| `DB_CONNECTION_TIMEOUT_MS`        | `5000`                      | Pool connection timeout                                                                    |
| `HEALTHCHECK_DATABASE_TIMEOUT_MS` | `2000`                      | DB timeout for `GET /health` and `GET /health/ready`                                       |
| `HEALTHCHECK_IPFS_TIMEOUT_MS`     | `1000`                      | Timeout for the Kubo `/api/v0/version` probe in `GET /health/ready`                        |
| `HEALTHCHECK_CACHE_MS`            | `1000`                      | Reuse readiness dependency results for this long (0 disables caching)                      |
| `SHUTDOWN_TIMEOUT_MS`             | `10000`                     | Graceful shutdown limit                                                                    |
| `SHUTDOWN_FORCE_CLOSE_MS`         | `8000`                      | Force-close remaining connections at this deadline (must be < `SHUTDOWN_TIMEOUT_MS`)       |

## Trust proxy

`TRUST_PROXY` is passed to `app.set('trust proxy', …)` and controls how `req.ip`
and `req.protocol` are derived from `X-Forwarded-For` / `X-Forwarded-Proto`.

| Value                | Meaning                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `false` (default)    | Trust nothing. `req.ip` is the socket address; spoofed headers are ignored.   |
| `1`, `2`, …          | Trust that many proxy hops from the socket (e.g. `1` for one load balancer).  |
| `10.0.0.0/8,::1/128` | Trust only requests whose socket address matches one of the listed CIDRs.     |

With `TRUST_PROXY=1`, `req.ip` is the left-most untrusted address in
`X-Forwarded-For`. Leave it `false` when the API is directly reachable, otherwise
clients can spoof their address. In production an unset `TRUST_PROXY` logs a
warning at startup. Every request is logged with `requestId`, method, path,
status, duration and `ip`.

## Test-only

| Variable              | Used by                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL`   | Postgres-backed tests (`src/__tests__/indexer.db.test.ts`). The database is wiped.                  |
| `TESTNET_INTEGRATION` | Set to `1` to run the live testnet integration test (see [CONTRIBUTING](../CONTRIBUTING.md#tests)). |

When you add a variable, add it to the schema, `.env.example`, this page and a test in
`src/__tests__/env.test.ts`.
