process.env.NODE_ENV = 'test';
process.env.PORT = '3000';

// Database configuration for isolated per-worker schemas.
// The base URL points at the test database; the global setup creates a
// schema named `test_<workerId>` per Jest worker and sets `search_path`
// per connection so workers never see each other's rows.
// If TEST_DATABASE_URL is provided it takes precedence over DATABASE_URL.
const baseDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://user:password@localhost:5432/folder_test';

process.env.DATABASE_URL = baseDatabaseUrl;
process.env.TEST_DATABASE_URL = baseDatabaseUrl;

// The schema name is derived from the Jest worker id by the global setup.
// Expose the worker id (when available) so test utilities can build the
// per-worker schema name consistently.
if (process.env.JEST_WORKER_ID) {
  process.env.TEST_SCHEMA = `test_${process.env.JEST_WORKER_ID}`;
}

process.env.STELLAR_RPC_URL =
  process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
process.env.STELLAR_NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
process.env.FOLDER_CONTRACT_ID =
  process.env.FOLDER_CONTRACT_ID ??
  'CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV';

process.env.IPFS_API_URL = process.env.IPFS_API_URL ?? 'http://localhost:5001';
process.env.IPFS_GATEWAY = process.env.IPFS_GATEWAY ?? 'https://ipfs.io/ipfs';

// RPC cassette recording/replay flag. Read from the environment so tests can
// opt in via `RPC_RECORD=1`; defaults to replay mode (unset).
process.env.RPC_RECORD = process.env.RPC_RECORD ?? '';

// IPFS integration flag. Read from the environment so CI can enable the
// Kubo-backed integration tests via `IPFS_INTEGRATION=1`; defaults to off.
process.env.IPFS_INTEGRATION = process.env.IPFS_INTEGRATION ?? '';

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
