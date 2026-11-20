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

## Network profiles

`STELLAR_NETWORK` selects a network profile. A profile bundles the network
passphrase, the default Soroban RPC URL and the deployed contract ID, so a
deployment is tied to exactly one network instead of relying on several
independent variables agreeing with each other.

| `STELLAR_NETWORK` | Passphrase                        | Default `STELLAR_RPC_URL`             | `FOLDER_CONTRACT_ID`                                       |
| ----------------- | --------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `testnet`         | `Test SDF Network ; September 2015` | `https://soroban-testnet.stellar.org` | `CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV` |
| `mainnet`         | `Public Global Stellar Network ; September 2015` | `https://soroban-mainnet.stellar.org` | see `networks.json` (unset until the mainnet deployment)   |
| `futurenet`       | `Test SDF Future Network ; October 2022` | `https://rpc-futurenet.stellar.org`   | see `networks.json`                                        |
| `local`           | `Standalone Network ; February 2017` | `http://localhost:8000/soroban/rpc`   | see `networks.json`                                        |

The profile values live in [`src/config/networks.json`](../src/config/networks.json),
which is synced from the `deployments/*.json` files in
[Indexer-Contract](https://github.com/D-Indexer/Indexer-Contract). Update it there
and in `.env.example` when a contract is redeployed.

### Overrides

Individual variables still override the profile values:

- `STELLAR_RPC_URL` overrides the profile's default RPC URL.
- `STELLAR_NETWORK_PASSPHRASE` overrides the profile's passphrase.
- `FOLDER_CONTRACT_ID` overrides the profile's contract ID.

Overrides must stay consistent with the selected profile. Mixing values from
different profiles — for example a mainnet contract ID with the testnet
passphrase, or a testnet RPC URL under `STELLAR_NETWORK=mainnet` — fails
validation at startup with an error naming the offending variable. A passphrase
or RPC URL that does not belong to any known profile is rejected the same way.

### Production

In `NODE_ENV=production`, `STELLAR_NETWORK` must be set explicitly; there is no
default profile. The resolved network is exposed as `network` in the responses
of `GET /` and `GET /health`, so a deployment's network can be verified without
reading its environment.

## Testnet values

| Variable                     | Value                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| `STELLAR_NETWORK`            | `testnet`                                                                 |
| `STELLAR_RPC_URL`            | `https://soroban-testnet.stellar.org`                                     |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015`                                       |
| `FOLDER_CONTRACT_ID`         | `CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV`                |
| `INDEXER_START_LEDGER`       | `5647760` (deployment ledger; only useful while the RPC still retains it) |

The contract ID comes from [`deployments/testnet.json`](https://github.com/D-Indexer/Indexer-Contract/blob/main/deployments/testnet.json)
in Indexer-Contract. Update it here and in `.env.example` when the contract is redeployed.

## Required

| Variable             | Validation                                | Purpose                                                                |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`       | non-empty                                 | PostgreSQL connection string                                           |
| `STELLAR_NETWORK`    | `testnet`, `mainnet`, `futurenet`, `local` | Selects the network profile. Required in production.                   |
| `STELLAR_RPC_URL`    | URL                                       | Soroban RPC endpoint. Defaults to the profile; query strings (API keys) are redacted from logs. |
| `FOLDER_CONTRACT_ID` | contract strkey (`C…`, 56 chars)          | Contract whose events are indexed. Defaults to the profile.            |
| `IPFS_API_URL`       | URL                                       | Kubo RPC API used by `POST /upload`                                    |
| `IPFS_GATEWAY`       | URL                                       | Public gateway base URL                                                |
| `CORS_ORIGIN`        | non-empty **in production only**          | See below                                                              |

## Optional

| Variable                          | Default                     | Purpose                                                                                    |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `NODE_ENV`                        | `development`               | `development`, `test` or `production`                                                      |
| `PORT`                            | `3000`                      | API port                                                                                   |
| `CORS_ORIGIN`                     | any origin (non-production) | Comma-separated allow-list, or `*` for any origin. An unparseable list denies all origins. |
| `REQUEST_BODY_LIMIT`              | `1mb`                       | JSON body limit                                                                            |
| `LOG_LEVEL`                       | `info`                      | `debug`, `info`, `warn`, `error` or `silent`                                               |
| `STELLAR_NETWORK`                 | `testnet` (non-production)  | `testnet`, `mainnet`, `futurenet` or `local`. Required in production.                      |
| `STELLAR_NETWORK_PASSPHRASE`      | profile passphrase          | Network passphrase (not used by the read-only indexer yet). Must match the profile.        |
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

## Test-only

| Variable              | Used by                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL`   | Postgres-backed tests (`src/__tests__/indexer.db.test.ts`). The database is wiped.                  |
| `TESTNET_INTEGRATION` | Set to `1` to run the live testnet integration test (see [CONTRIBUTING](../CONTRIBUTING.md#tests)). |

When you add a variable, add it to the schema, `.env.example`, this page and a test in
`src/__tests__/env.test.ts`. When a network is added or a contract is redeployed, update
`src/config/networks.json` and the profile table above.
