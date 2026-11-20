process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';

/**
 * Minimal environment used only by integration tests that exercise real I/O
 * (database, RPC, IPFS). Unit tests should build the app via
 * `createTestContainer` from `src/container.ts` with explicit dependencies
 * instead of relying on global env mutation.
 */
export const integrationEnv = {
  PORT: '3000',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/folder_test',
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  FOLDER_CONTRACT_ID: 'CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV',
  IPFS_API_URL: 'http://localhost:5001',
  IPFS_GATEWAY: 'https://ipfs.io/ipfs',
} as const;

/**
 * Applies the integration environment to `process.env`. Call this explicitly
 * from integration test suites (e.g. in `beforeAll`) rather than relying on
 * import-time mutation.
 */
export function applyIntegrationEnv(): void {
  for (const [key, value] of Object.entries(integrationEnv)) {
    process.env[key] = value;
  }
}

/**
 * Restores `process.env` to the state captured before `applyIntegrationEnv`
 * was called. Use in `afterAll` to avoid leaking configuration between suites.
 */
export function restoreIntegrationEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(integrationEnv)) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

/**
 * Convenience helper: builds a test container with explicit dependencies.
 * Re-exported here so tests can import everything they need from one place.
 */
export { createTestContainer } from '../container';