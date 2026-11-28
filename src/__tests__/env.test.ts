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
    expect(env.INDEXER_MAX_GAP_RESUME_ATTEMPTS).toBe(5);
    expect(env.INDEXER_START_LEDGER).toBeUndefined();
    expect(env.IPFS_VERIFY_CID).toBe(true);
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

  it('parses an ordered multi-contract list and per-contract starts', () => {
    const env = loadEnv({
      ...validEnv,
      FOLDER_CONTRACT_ID: '',
      FOLDER_CONTRACT_IDS: `${TESTNET_CONTRACT_ID}:5647760`,
    });
    expect(env.FOLDER_CONTRACT_IDS).toContain(TESTNET_CONTRACT_ID);
  });

  it('parses indexer tuning', () => {
    const env = loadEnv({ ...validEnv, INDEXER_START_LEDGER: '5647760', INDEXER_ON_RETENTION_GAP: 'skip' });
    expect(env.INDEXER_START_LEDGER).toBe(5647760);
    expect(env.INDEXER_ON_RETENTION_GAP).toBe('skip');
    expect(loadEnv({ ...validEnv, INDEXER_START_LEDGER: '' }).INDEXER_START_LEDGER).toBeUndefined();
    expect(() => loadEnv({ ...validEnv, INDEXER_ON_RETENTION_GAP: 'ignore' })).toThrow();
    expect(loadEnv({ ...validEnv, INDEXER_MAX_GAP_RESUME_ATTEMPTS: '2' }).INDEXER_MAX_GAP_RESUME_ATTEMPTS).toBe(2);
    expect(() => loadEnv({ ...validEnv, INDEXER_MAX_GAP_RESUME_ATTEMPTS: '0' })).toThrow();
  });

  it('applies upload and pdf parsing defaults', () => {
    const env = loadEnv(validEnv);

    expect(env.UPLOAD_MAX_IMAGE_PIXELS).toBe(40_000_000);
    expect(env.UPLOAD_MAX_IMAGE_SIDE).toBe(10_000);
    expect(env.UPLOAD_MAX_CONCURRENT).toBeGreaterThan(0);
    expect(env.UPLOAD_BUNDLE_MAX_FILES).toBeGreaterThan(0);
    expect(env.UPLOAD_BUNDLE_MAX_BYTES).toBeGreaterThan(0);
    expect(env.PDF_PARSE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('parses upload and pdf parsing overrides', () => {
    const env = loadEnv({
      ...validEnv,
      UPLOAD_MAX_IMAGE_PIXELS: '1000000',
      UPLOAD_MAX_IMAGE_SIDE: '4096',
      UPLOAD_MAX_CONCURRENT: '2',
      UPLOAD_BUNDLE_MAX_FILES: '5',
      UPLOAD_BUNDLE_MAX_BYTES: '1048576',
      PDF_PARSE_TIMEOUT_MS: '1500',
    });

    expect(env.UPLOAD_MAX_IMAGE_PIXELS).toBe(1_000_000);
    expect(env.UPLOAD_MAX_IMAGE_SIDE).toBe(4096);
    expect(env.UPLOAD_MAX_CONCURRENT).toBe(2);
    expect(env.UPLOAD_BUNDLE_MAX_FILES).toBe(5);
    expect(env.UPLOAD_BUNDLE_MAX_BYTES).toBe(1_048_576);
    expect(env.PDF_PARSE_TIMEOUT_MS).toBe(1500);
  });

  it('rejects non-positive upload limits', () => {
    expect(() => loadEnv({ ...validEnv, UPLOAD_MAX_CONCURRENT: '0' })).toThrow(/UPLOAD_MAX_CONCURRENT/);
    expect(() => loadEnv({ ...validEnv, UPLOAD_MAX_IMAGE_PIXELS: '-1' })).toThrow(/UPLOAD_MAX_IMAGE_PIXELS/);
    expect(() => loadEnv({ ...validEnv, PDF_PARSE_TIMEOUT_MS: '0' })).toThrow(/PDF_PARSE_TIMEOUT_MS/);
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
