import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { createHash } from 'crypto';

const optionalPositiveInt = z
  .union([z.literal('').transform(() => undefined), z.coerce.number().int().positive()])
  .optional();

/** Deployed Folder contract on Stellar testnet (Indexer-Contract deployments/testnet.json). */
export const TESTNET_CONTRACT_ID = 'CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV';
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

export function networkId(passphrase: string): string {
  return createHash('sha256').update(passphrase).digest('hex');
}

export type FolderContractConfig = { contractIds: string[]; startLedgers: Record<string, number> };

export function parseFolderContractConfig(
  source: {
    FOLDER_CONTRACT_ID?: string;
    FOLDER_CONTRACT_IDS?: string;
    FOLDER_CONTRACT_START_LEDGERS?: string;
    INDEXER_START_LEDGER?: number | string;
  }
): FolderContractConfig {
  const legacy = source.FOLDER_CONTRACT_ID?.trim();
  const rawList = source.FOLDER_CONTRACT_IDS?.trim();
  const entries: Array<{ id: string; startLedger?: number }> = [];

  if (rawList) {
    for (const item of rawList.split(/[,;\s]+/).filter(Boolean)) {
      const match = /^([A-Z0-9]+)(?:[:=](\d+))?$/.exec(item);
      if (match) entries.push({ id: match[1], startLedger: match[2] ? Number(match[2]) : undefined });
      else entries.push({ id: item });
    }
  } else if (legacy) {
    entries.push({ id: legacy });
  }

  const starts: Record<string, number> = {};
  const startList = source.FOLDER_CONTRACT_START_LEDGERS?.trim();
  if (startList) {
    for (const item of startList.split(/[,;\s]+/).filter(Boolean)) {
      const match = /^([A-Z0-9]+)[:=](\d+)$/.exec(item);
      if (match) starts[match[1]] = Number(match[2]);
    }
  }
  for (const entry of entries) {
    if (entry.startLedger) starts[entry.id] = entry.startLedger;
  }
  const fallbackStart = source.INDEXER_START_LEDGER ? Number(source.INDEXER_START_LEDGER) : undefined;
  for (const entry of entries) if (!starts[entry.id] && fallbackStart) starts[entry.id] = fallbackStart;

  return { contractIds: [...new Set(entries.map((entry) => entry.id))], startLedgers: starts };
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    STELLAR_RPC_URL: z
      .string({ required_error: `STELLAR_RPC_URL is required (testnet: ${TESTNET_RPC_URL})` })
      .url('STELLAR_RPC_URL must be a valid URL'),
    STELLAR_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    STELLAR_NETWORK_PASSPHRASE: z.string().min(1).default(TESTNET_PASSPHRASE),
    FOLDER_CONTRACT_ID: z
      .string()
      .optional()
      .refine((value) => value === undefined || value.trim() === '' || StrKey.isValidContract(value), 'FOLDER_CONTRACT_ID must be a contract address (C..., 56 characters)'),
    FOLDER_CONTRACT_IDS: z.string().optional(),
    FOLDER_CONTRACT_START_LEDGERS: z.string().optional(),
    API_NETWORK_DEFAULT: z.string().optional(),
    IPFS_API_URL: z.string().url('IPFS_API_URL must be a valid URL'),
    IPFS_GATEWAY: z.string().url('IPFS_GATEWAY must be a valid URL'),
    IPFS_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    CORS_ORIGIN: z.string().optional(),
    REQUEST_BODY_LIMIT: z.string().default('1mb'),
    INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    INDEXER_PAGE_LIMIT: z.coerce.number().int().min(1).max(10000).default(200),
    INDEXER_START_LEDGER: optionalPositiveInt,
    INDEXER_ON_RETENTION_GAP: z.enum(['halt', 'skip']).default('halt'),
    INDEXER_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(60000),
    INDEXER_STALE_AFTER_MS: z.coerce.number().int().positive().default(120000),
    DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    HEALTHCHECK_DATABASE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  })
  .superRefine((env, ctx) => {
    const contracts = parseFolderContractConfig(env);
    if (contracts.contractIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FOLDER_CONTRACT_ID'],
        message: `FOLDER_CONTRACT_ID is required (testnet: ${TESTNET_CONTRACT_ID})`,
      });
    }
    for (const contractId of contracts.contractIds) {
      if (!StrKey.isValidContract(contractId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FOLDER_CONTRACT_IDS'],
          message: 'FOLDER_CONTRACT_IDS must contain contract addresses (C..., 56 characters)',
        });
        break;
      }
    }
    if (env.NODE_ENV === 'production' && !env.CORS_ORIGIN?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN is required in production (comma-separated origins, or * to allow all)',
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.errors
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}. See docs/configuration.md`);
  }

  return parsed.data;
}

export function getEnv(): AppEnv {
  if (!cachedEnv) {
    cachedEnv = loadEnv();
  }

  return cachedEnv;
}

export function resetEnvCacheForTests(): void {
  cachedEnv = null;
}
