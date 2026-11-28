import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  describe('secret files', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'folder-env-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const writeSecret = (name: string, content: string): string => {
      const file = join(dir, name);
      writeFileSync(file, content);
      return file;
    };

    it('loads DATABASE_URL from DATABASE_URL_FILE using trimmed content', () => {
      const secret = 'postgresql://user:file-password@localhost:5432/folder_test';
      const file = writeSecret('database_url', `  ${secret}\n`);
      const env: Record<string, string> = { ...validEnv };
      delete env.DATABASE_URL;

      expect(loadEnv({ ...env, DATABASE_URL_FILE: file }).DATABASE_URL).toBe(secret);
    });

    it('loads IPFS_API_AUTH from IPFS_API_AUTH_FILE using trimmed content', () => {
      const file = writeSecret('ipfs_auth', 'Bearer file-token\n');
      expect(loadEnv({ ...validEnv, IPFS_API_AUTH_FILE: file }).IPFS_API_AUTH).toBe('Bearer file-token');
    });

    it('errors when both the env var and the file are set', () => {
      const file = writeSecret('database_url', 'postgresql://user:file@localhost:5432/folder_test');
      expect(() => loadEnv({ ...validEnv, DATABASE_URL_FILE: file })).toThrow(/DATABASE_URL/);
      expect(() => loadEnv({ ...validEnv, DATABASE_URL_FILE: file })).toThrow(/both/i);
    });

    it('errors when the secret file does not exist', () => {
      const env: Record<string, string> = { ...validEnv };
      delete env.DATABASE_URL;
      expect(() => loadEnv({ ...env, DATABASE_URL_FILE: join(dir, 'missing') })).toThrow(/DATABASE_URL_FILE/);
    });

    it('never includes secret values in validation errors', () => {
      const secret = 'postgresql://user:super-secret-password@localhost:5432/folder_test';
      let message = '';
      try {
        loadEnv({ ...validEnv, DATABASE_URL: secret, STELLAR_RPC_URL: 'not-a-url' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/STELLAR_RPC_URL/);
      expect(message).not.toContain('super-secret-password');
      expect(message).not.toContain(secret);
    });
  });
});
