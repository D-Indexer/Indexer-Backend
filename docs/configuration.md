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
| `HEALTHCHECK_DATABASE_TIMEOUT_MS` | `2000`                      | DB timeout for `GET /health`                                                               |
| `SHUTDOWN_TIMEOUT_MS`             | `10000`                     | Graceful shutdown limit                                                                    |
| `PORTFOLIO_TRANSFERS_ENABLED`     | `false`                     | Decode and apply portfolio ownership transfer events (see below)                           |
| `FEDERATION_ENABLED`              | `false`                     | Serve `/.well-known/stellar.toml` and `GET /federation` (SEP-1/SEP-2)                      |
| `FEDERATION_DOMAIN`               | unset                       | Domain used in federation addresses (`name*<domain>`); required when federation is enabled |
| `FEDERATION_SERVER_URL`           | unset                       | Absolute URL advertised as `FEDERATION_SERVER`; defaults to `PUBLIC_BASE_URL` + `/federation` |
| `PUBLIC_BASE_URL`                 | unset                       | Public origin of the API, used to build absolute URLs in `stellar.toml`                    |
| `STELLAR_TOML_ORG_NAME`           | `Folder`                    | `DOCUMENTATION.ORG_NAME` in `stellar.toml`                                                 |
| `STELLAR_TOML_ORG_URL`            | unset                       | `DOCUMENTATION.ORG_URL` in `stellar.toml`                                                  |
| `STELLAR_TOML_ORG_EMAIL`          | unset                       | `DOCUMENTATION.ORG_EMAIL` in `stellar.toml`                                                |
| `SERVER_TIMING`                   | `false` in production       | Emit `Server-Timing` headers. Enabled by default outside production.                       |
| `SLOW_REQUEST_THRESHOLD_MS`       | `1000`                      | Requests slower than this log a warning with the timing breakdown                          |

## Portfolio transfers

`PORTFOLIO_TRANSFERS_ENABLED` gates the decoder and handler for portfolio
ownership transfer events. While it is `false` (the default) the indexer ignores
transfer events and portfolios remain keyed by their original owner, so existing
endpoints behave exactly as before. Enable it only once the contract emits the
agreed transfer event shape; see [architecture](architecture.md#portfolio-transfers)
for the event format and the ownership-history model.

## Federation (SEP-1 / SEP-2)

Setting `FEDERATION_ENABLED=true` exposes `/.well-known/stellar.toml` and
`GET /federation`. `FEDERATION_DOMAIN` is the domain wallets append to folder
names (`alice*<FEDERATION_DOMAIN>`); it must match the host serving the toml.
`FEDERATION_SERVER_URL` is advertised verbatim in the toml and defaults to
`PUBLIC_BASE_URL` + `/federation`, so set `PUBLIC_BASE_URL` when the API sits
behind a proxy. The `STELLAR_TOML_ORG_*` variables fill the optional
`DOCUMENTATION` section; unset values are omitted from the toml.

## Server-Timing

`SERVER_TIMING` controls the `Server-Timing` response header. It defaults to
enabled in development and test and disabled in production; set
`SERVER_TIMING=true` to turn it on in production (for example on a canary) and
`SERVER_TIMING=false` to silence it elsewhere. When enabled, responses carry
`db`, `ipfs` and `app` entries. Requests slower than `SLOW_REQUEST_THRESHOLD_MS`
always log a warning with the same breakdown, regardless of this flag.

## Test-only

| Variable              | Used by                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL`   | Postgres-backed tests (`src/__tests__/indexer.db.test.ts`). The database is wiped.                  |
| `TESTNET_INTEGRATION` | Set to `1` to run the live testnet integration test (see [CONTRIBUTING](../CONTRIBUTING.md#tests)). |

When you add a variable, add it to the schema, `.env.example`, this page and a test in
`src/__tests__/env.test.ts`.
