# Configuration

Configuration is loaded from environment variables and validated at startup.

## Required Variables

| Variable | Purpose |
| -------- | ------- |
| `DATABASE_URL` | PostgreSQL connection string |
| `STELLAR_RPC_URL` | Soroban RPC endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | Stellar network passphrase |
| `FOLDER_CONTRACT_ID` | Folder contract ID to index |
| `IPFS_API_URL` | Kubo/IPFS RPC URL |
| `IPFS_GATEWAY` | Public gateway base URL |

## Optional Variables

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | Runtime mode |
| `CORS_ORIGIN` | any origin | Comma-separated allowed origins |
| `REQUEST_BODY_LIMIT` | `1mb` | JSON body limit |
| `INDEXER_POLL_INTERVAL_MS` | `5000` | Soroban polling interval |
| `DB_MAX_CONNECTIONS` | `10` | PostgreSQL pool size |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Pool idle timeout |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` | Pool connection timeout |
| `HEALTHCHECK_DATABASE_TIMEOUT_MS` | `2000` | Health DB timeout |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful shutdown timeout |
| `WEBHOOK_SECRET` | unset | Reserved for webhook integrations |
| `PUBLIC_BASE_URL` | unset | Public service URL, if deployed |

## Local Example

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

Keep `.env.example` synchronized when adding or changing configuration.
