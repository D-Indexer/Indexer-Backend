import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { logger } from '../utils/logger';

const optionalPositiveInt = z
  .union([z.literal('').transform(() => undefined), z.coerce.number().int().positive()])
  .optional();

const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const IPV6_CIDR = /^[0-9a-fA-F:]+\/\d{1,3}$/;

/**
 * TRUST_PROXY: `false` (default), a hop count, or a comma-separated CIDR list.
 * Anything else is rejected so a typo cannot silently trust spoofed headers.
 */
const trustProxySchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const raw = value?.trim();
    if (!raw || raw.toLowerCase() === 'false') return false as const;
    if (raw.toLowerCase() === 'true') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'TRUST_PROXY must be false, a hop count, or a comma-separated CIDR list',
      });
      return z.NEVER;
    }
    if (/^\d+$/.test(raw)) {
      const hops = Number(raw);
      if (hops < 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'TRUST_PROXY hop count must be >= 1' });
        return z.NEVER;
      }
      return hops;
    }
    const cidrs = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (cidrs.length === 0 || !cidrs.every((cidr) => IPV4_CIDR.test(cidr) || IPV6_CIDR.test(cidr))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'TRUST_PROXY must be false, a hop count, or a comma-separated CIDR list',
      });
      return z.NEVER;
    }
    return cidrs;
  });

/** Deployed Folder contract on Stellar testnet (Indexer-Contract deployments/testnet.json). */
export const TESTNET_CONTRACT_ID = 'CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV';
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

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
      .string({ required_error: `FOLDER_CONTRACT_ID is required (testnet: ${TESTNET_CONTRACT_ID})` })
      .refine(
        (value) => StrKey.isValidContract(value),
        'FOLDER_CONTRACT_ID must be a contract address (C..., 56 characters)'
      ),
    IPFS_API_URL: z.string().url('IPFS_API_URL must be a valid URL'),
    IPFS_GATEWAY: z.string().url('IPFS_GATEWAY must be a valid URL'),
    IPFS_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    CORS_ORIGIN: z.string().optional(),
    TRUST_PROXY: trustProxySchema,
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
    SHUTDOWN_FORCE_CLOSE_MS: z.coerce.number().int().positive().default(8000),
    HEALTHCHECK_DATABASE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    HEALTHCHECK_IPFS_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
    HEALTHCHECK_CACHE_MS: z.coerce.number().int().nonnegative().default(1000),
  })
  .superRefine((env, ctx) => {
    if (env.SHUTDOWN_FORCE_CLOSE_MS >= env.SHUTDOWN_TIMEOUT_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHUTDOWN_FORCE_CLOSE_MS'],
        message: 'SHUTDOWN_FORCE_CLOSE_MS must be shorter than SHUTDOWN_TIMEOUT_MS',
      });
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

/** Express `trust proxy` setting derived from TRUST_PROXY. */
export type TrustProxy = AppEnv['TRUST_PROXY'];

/** Warn (once) when production runs without TRUST_PROXY, so client IPs may be wrong. */
export function warnIfTrustProxyUnset(env: Pick<AppEnv, 'NODE_ENV' | 'TRUST_PROXY'>): void {
  if (env.NODE_ENV === 'production' && env.TRUST_PROXY === false) {
    logger.warn(
      'TRUST_PROXY is unset in production; req.ip will be the load balancer address. Set TRUST_PROXY to the hop count or trusted CIDRs.'
    );
  }
}

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
