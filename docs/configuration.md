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

## Secrets from files (`*_FILE`)

Every secret-bearing variable can instead be supplied as a file, which is how
Docker and Kubernetes secrets are mounted:

| Variable          | File variant          |
| ----------------- | --------------------- |
| `DATABASE_URL`    | `DATABASE_URL_FILE`   |
| `IPFS_API_AUTH`   | `IPFS_API_AUTH_FILE`  |

Rules:

- `<NAME>_FILE` points to a file whose **trimmed** content is used as the value
  of `<NAME>` (trailing newlines from `echo`/secret mounts are ignored).
- Setting both `<NAME>` and `<NAME>_FILE` is an error; the process exits at
  startup. Prefer the file variant in containers.
- A missing or unreadable file is an error.
- Secret values are never printed: validation errors name the variable but
  redact its value.

Example with Docker Compose secrets:

```yaml
services:
  api:
    secrets:
      - database_url
    environment:
      DATABASE_URL_FILE: /run/secrets/database_url
secrets:
  database_url:
    file: ./secrets/database_url.txt
```

With Kubernetes, mount the secret as a file and set `DATABASE_URL_FILE` (or
`IPFS_API_AUTH_FILE`) to the mount path, e.g. `/etc/secrets/database_url`.

## Testnet values
=======

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
| `IPFS_API_AUTH`                   | unset                       | Kubo RPC `Authorization` header value. Also accepts `IPFS_API_AUTH_FILE`.                  |
| `DB_MAX_CONNECTIONS`              | `10`                        | Pool size, per process                                                                     |
| `DB_IDLE_TIMEOUT_MS`              | `30000`                     | Pool idle timeout                                                                          |
| `DB_CONNECTION_TIMEOUT_MS`        | `5000`                      | Pool connection timeout                                                                    |
| `HEALTHCHECK_DATABASE_TIMEOUT_MS` | `2000`                      | DB timeout for `GET /health`                                                               |
| `SHUTDOWN_TIMEOUT_MS`             | `10000`                     | Graceful shutdown limit                                                                    |

## Test-only

| Variable              | Used by                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL`   | Postgres-backed tests (`src/__tests__/indexer.db.test.ts`). The database is wiped.                  |
| `TESTNET_INTEGRATION` | Set to `1` to run the live testnet integration test (see [CONTRIBUTING](../CONTRIBUTING.md#tests)). |

When you add a variable, add it to the schema, `.env.example`, this page and a test in
`src/__tests__/env.test.ts`.
