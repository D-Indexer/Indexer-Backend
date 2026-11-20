import { loadEnv, TESTNET_CONTRACT_ID } from '../config/env';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/folder_test',
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  FOLDER_CONTRACT_ID: TESTNET_CONTRACT_ID,
  IPFS_API_URL: 'http://localhost:5001',
  IPFS_GATEWAY: 'https://ipfs.io/ipfs',
};

describe('environment configuration', () => {
  it('parses required runtime configuration', () => {
    const env = loadEnv(validEnv);

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('test');
    expect(env.INDEXER_POLL_INTERVAL_MS).toBe(5000);
    expect(env.INDEXER_ON_RETENTION_GAP).toBe('halt');
    expect(env.INDEXER_START_LEDGER).toBeUndefined();
  });

  it('rejects invalid urls', () => {
    expect(() => loadEnv({ ...validEnv, STELLAR_RPC_URL: 'not-a-url' })).toThrow(/STELLAR_RPC_URL/);
  });

  it.each(['FOLDER_CONTRACT_ID', 'STELLAR_RPC_URL'])('fails fast with a hint when %s is missing', (key) => {
    const env: Record<string, string> = { ...validEnv };
    delete env[key];
    expect(() => loadEnv(env)).toThrow(new RegExp(`${key} is required \\(testnet: `));
  });

  it('rejects a FOLDER_CONTRACT_ID that is not a contract address', () => {
    expect(() => loadEnv({ ...validEnv, FOLDER_CONTRACT_ID: 'CCONTRACT' })).toThrow(/contract address/);
    expect(() =>
      loadEnv({ ...validEnv, FOLDER_CONTRACT_ID: 'GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ' })
    ).toThrow(/contract address/);
  });

  it('parses indexer tuning', () => {
    const env = loadEnv({ ...validEnv, INDEXER_START_LEDGER: '5647760', INDEXER_ON_RETENTION_GAP: 'skip' });
    expect(env.INDEXER_START_LEDGER).toBe(5647760);
    expect(env.INDEXER_ON_RETENTION_GAP).toBe('skip');
    expect(loadEnv({ ...validEnv, INDEXER_START_LEDGER: '' }).INDEXER_START_LEDGER).toBeUndefined();
    expect(() => loadEnv({ ...validEnv, INDEXER_ON_RETENTION_GAP: 'ignore' })).toThrow();
  });

  it('requires CORS_ORIGIN in production', () => {
    expect(() => loadEnv({ ...validEnv, NODE_ENV: 'production' })).toThrow(/CORS_ORIGIN is required/);
    expect(
      loadEnv({ ...validEnv, NODE_ENV: 'production', CORS_ORIGIN: 'https://folder.app' }).CORS_ORIGIN
    ).toBe('https://folder.app');
  });

  it('parses resumable upload tuning with defaults', () => {
    const env = loadEnv(validEnv);
    expect(env.RESUMABLE_UPLOAD_DIR).toBeTruthy();
    expect(env.RESUMABLE_UPLOAD_TTL_MS).toBeGreaterThan(0);
    expect(env.RESUMABLE_UPLOAD_MAX_BYTES).toBeGreaterThan(0);
    expect(env.RESUMABLE_UPLOAD_CLEANUP_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('accepts resumable upload overrides', () => {
    const env = loadEnv({
      ...validEnv,
      RESUMABLE_UPLOAD_DIR: '/var/tmp/uploads',
      RESUMABLE_UPLOAD_TTL_MS: '3600000',
      RESUMABLE_UPLOAD_MAX_BYTES: '104857600',
      RESUMABLE_UPLOAD_CLEANUP_INTERVAL_MS: '60000',
    });
    expect(env.RESUMABLE_UPLOAD_DIR).toBe('/var/tmp/uploads');
    expect(env.RESUMABLE_UPLOAD_TTL_MS).toBe(3600000);
    expect(env.RESUMABLE_UPLOAD_MAX_BYTES).toBe(104857600);
    expect(env.RESUMABLE_UPLOAD_CLEANUP_INTERVAL_MS).toBe(60000);
  });

  it('rejects invalid resumable upload tuning', () => {
    expect(() => loadEnv({ ...validEnv, RESUMABLE_UPLOAD_TTL_MS: '0' })).toThrow(/RESUMABLE_UPLOAD_TTL_MS/);
    expect(() => loadEnv({ ...validEnv, RESUMABLE_UPLOAD_MAX_BYTES: '-1' })).toThrow(
      /RESUMABLE_UPLOAD_MAX_BYTES/
    );
  });

  it('falls back to DATABASE_URL when per-process urls are unset', () => {
    const env = loadEnv(validEnv);
    expect(env.API_DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(env.INDEXER_DATABASE_URL).toBe(validEnv.DATABASE_URL);
  });

  it('accepts separate API and indexer database urls', () => {
    const env = loadEnv({
      ...validEnv,
      API_DATABASE_URL: 'postgresql://folder_api:secret@localhost:5432/folder_test',
      INDEXER_DATABASE_URL: 'postgresql://folder_indexer:secret@localhost:5432/folder_test',
    });
    expect(env.API_DATABASE_URL).toBe('postgresql://folder_api:secret@localhost:5432/folder_test');
    expect(env.INDEXER_DATABASE_URL).toBe('postgresql://folder_indexer:secret@localhost:5432/folder_test');
  });

  it('rejects invalid per-process database urls', () => {
    expect(() => loadEnv({ ...validEnv, API_DATABASE_URL: 'not-a-url' })).toThrow(/API_DATABASE_URL/);
    expect(() => loadEnv({ ...validEnv, INDEXER_DATABASE_URL: 'not-a-url' })).toThrow(/INDEXER_DATABASE_URL/);
  });
});
