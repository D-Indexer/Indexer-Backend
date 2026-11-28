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
=======

| Variable                     | Value                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| `STELLAR_NETWORK`            | `testnet`                                                                 |
| `STELLAR_RPC_URL`            | `https://soroban-testnet.stellar.org`                                     |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015`                                       |
| `FOLDER_CONTRACT_ID`         | `CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV`                |
| `INDEXER_START_LEDGER`       | `5647760` (deployment ledger; only useful while the RPC still retains it) |

The contract ID comes from [`deployments/testnet.json`](https://github.com/D-Indexer/Indexer-Contract/blob/main/deployments/testnet.json)
in Indexer-Contract. Update it here and in `.env.example` when the contract is redeployed.

<!-- BEGIN GENERATED CONFIG -->
<!-- END GENERATED CONFIG -->

## API keys

`API_KEY_HMAC_SECRET` enables optional API keys on read endpoints (see
[API keys](api.md#api-keys)). Keys are stored only as an HMAC-SHA256 under this secret, so:

- it must be at least 32 characters (`openssl rand -hex 32`) and treated like a password;
- the API and the `npm run keys` CLI must use the same value;
- changing it invalidates every issued key.

Unset, API keys are disabled: requests are served anonymously and `Authorization` headers
are ignored.

When you add a variable, add it to the schema in
[`src/config/env.ts`](../src/config/env.ts) with its description, default and example,
then run `npm run docs:config` to regenerate this page and `.env.example`. CI fails when
the generated output differs from the committed files.
