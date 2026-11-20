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

  it('parses upload quota configuration', () => {
    const env = loadEnv({
      ...validEnv,
      UPLOAD_DAILY_BYTE_QUOTA: '1048576',
      UPLOAD_DAILY_FILE_QUOTA: '25',
      UPLOAD_IP_HASH_SALT: 'a-very-secret-salt',
    });

    expect(env.UPLOAD_DAILY_BYTE_QUOTA).toBe(1048576);
    expect(env.UPLOAD_DAILY_FILE_QUOTA).toBe(25);
    expect(env.UPLOAD_IP_HASH_SALT).toBe('a-very-secret-salt');
  });

  it('applies upload quota defaults and rejects invalid values', () => {
    const env = loadEnv(validEnv);
    expect(env.UPLOAD_DAILY_BYTE_QUOTA).toBeGreaterThan(0);
    expect(env.UPLOAD_DAILY_FILE_QUOTA).toBeGreaterThan(0);
    expect(env.UPLOAD_IP_HASH_SALT).toBeDefined();

    expect(() => loadEnv({ ...validEnv, UPLOAD_DAILY_BYTE_QUOTA: '-1' })).toThrow(/UPLOAD_DAILY_BYTE_QUOTA/);
    expect(() => loadEnv({ ...validEnv, UPLOAD_DAILY_FILE_QUOTA: 'abc' })).toThrow(/UPLOAD_DAILY_FILE_QUOTA/);
  });

  it('leaves DATABASE_READ_URL unset by default', () => {
    const env = loadEnv(validEnv);
    expect(env.DATABASE_READ_URL).toBeUndefined();
    expect(env.DB_REPLICA_MAX_LAG_MS).toBeGreaterThan(0);
  });

  it('parses DATABASE_READ_URL and DB_REPLICA_MAX_LAG_MS', () => {
    const env = loadEnv({
      ...validEnv,
      DATABASE_READ_URL: 'postgresql://user:password@replica:5432/folder_test',
      DB_REPLICA_MAX_LAG_MS: '2500',
    });

    expect(env.DATABASE_READ_URL).toBe('postgresql://user:password@replica:5432/folder_test');
    expect(env.DB_REPLICA_MAX_LAG_MS).toBe(2500);
  });

  it('rejects an invalid DATABASE_READ_URL', () => {
    expect(() => loadEnv({ ...validEnv, DATABASE_READ_URL: 'not-a-url' })).toThrow(/DATABASE_READ_URL/);
  });
});
