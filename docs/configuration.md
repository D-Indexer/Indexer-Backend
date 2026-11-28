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

<!-- BEGIN GENERATED CONFIG -->
<!-- END GENERATED CONFIG -->

When you add a variable, add it to the schema in
[`src/config/env.ts`](../src/config/env.ts) with its description, default and example,
then run `npm run docs:config` to regenerate this page and `.env.example`. CI fails when
the generated output differs from the committed files.
