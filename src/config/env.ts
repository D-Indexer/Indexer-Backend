import { StrKey } from '@stellar/stellar-base';
import { z } from 'zod';
import networksJson from './networks.json';

const optionalPositiveInt = z
  .union([z.literal('').transform((): undefined => undefined), z.coerce.number().int().positive()])
  .optional();

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Documentation metadata for each environment variable.
 *
 * This map is the single source of truth for `docs/configuration.md` and
 * `.env.example` (see `scripts/gen-config-docs.ts`). Every field in
 * `envSchema` must have an entry here; the generator fails otherwise.
 */
export interface EnvVarMeta {
  /** Human readable description of the variable. */
  description: string;
  /** Default value applied by the schema, if any. */
  default?: string;
  /** Example value shown in the docs. */
  example?: string;
  /** Whether the value is sensitive and must not be logged or committed. */
  secret?: boolean;
  /** Whether the variable must be provided (no default). */
  required?: boolean;
}

export const envVarMeta: Record<keyof AppEnv, EnvVarMeta> = {
  NODE_ENV: {
    description: 'Runtime environment. Controls production-only validation rules.',
    default: 'development',
    example: 'production',
  },
  PORT: {
    description: 'HTTP port the API server listens on.',
    default: '3000',
    example: '3000',
  },
  DATABASE_URL: {
    description: 'PostgreSQL connection string used by the API and indexer.',
    example: 'postgres://postgres:postgres@localhost:5432/folder',
    secret: true,
    required: true,
  },
  STELLAR_RPC_URL: {
    description: 'Soroban RPC endpoint used to read contract state and events.',
    example: TESTNET_RPC_URL,
    required: true,
  },
  STELLAR_RPC_TIMEOUT_MS: {
    description: 'Timeout in milliseconds for individual Stellar RPC requests.',
    default: '10000',
    example: '10000',
  },
  STELLAR_NETWORK_PASSPHRASE: {
    description: 'Stellar network passphrase used to sign and verify transactions.',
    default: TESTNET_PASSPHRASE,
    example: TESTNET_PASSPHRASE,
  },
  FOLDER_CONTRACT_ID: {
    description: 'Contract address (C..., 56 characters) of the deployed Folder contract.',
    example: TESTNET_CONTRACT_ID,
    required: true,
  },
  IPFS_API_URL: {
    description: 'IPFS HTTP API endpoint used to pin and upload content.',
    example: 'http://localhost:5001/api/v0',
    required: true,
  },
  IPFS_GATEWAY: {
    description: 'Public IPFS gateway used to build content URLs.',
    example: 'http://localhost:8080/ipfs',
    required: true,
  },
  IPFS_TIMEOUT_MS: {
    description: 'Timeout in milliseconds for IPFS API requests.',
    default: '30000',
    example: '30000',
  },
  CORS_ORIGIN: {
    description:
      'Comma-separated list of allowed CORS origins, or * to allow all. Required in production.',
    example: 'https://app.example.com',
  },
  REQUEST_BODY_LIMIT: {
    description: 'Maximum accepted request body size (express body-parser syntax).',
    default: '1mb',
    example: '1mb',
  },
  INDEXER_POLL_INTERVAL_MS: {
    description: 'Interval in milliseconds between indexer polls for new ledgers.',
    default: '5000',
    example: '5000',
  },
  INDEXER_PAGE_LIMIT: {
    description: 'Maximum number of contract events fetched per indexer page (1-10000).',
    default: '200',
    example: '200',
  },
  INDEXER_START_LEDGER: {
    description: 'Ledger to start indexing from when no checkpoint exists. Defaults to the latest ledger.',
    example: '1234567',
  },
  INDEXER_ON_RETENTION_GAP: {
    description: 'Behaviour when the indexer falls behind the RPC retention window: halt or skip.',
    default: 'halt',
    example: 'halt',
  },
  INDEXER_MAX_BACKOFF_MS: {
    description: 'Maximum backoff in milliseconds between indexer retries.',
    default: '60000',
    example: '60000',
  },
  INDEXER_STALE_AFTER_MS: {
    description: 'Age in milliseconds after which the indexer is considered stale by health checks.',
    default: '120000',
    example: '120000',
  },
  DB_MAX_CONNECTIONS: {
    description: 'Maximum number of PostgreSQL connections in the pool.',
    default: '10',
    example: '10',
  },
  DB_IDLE_TIMEOUT_MS: {
    description: 'Idle timeout in milliseconds for pooled PostgreSQL connections.',
    default: '30000',
    example: '30000',
  },
  DB_CONNECTION_TIMEOUT_MS: {
    description: 'Timeout in milliseconds when acquiring a PostgreSQL connection.',
    default: '5000',
    example: '5000',
  },
  SHUTDOWN_TIMEOUT_MS: {
    description: 'Grace period in milliseconds for in-flight work during graceful shutdown.',
    default: '10000',
    example: '10000',
  },
  HEALTHCHECK_DATABASE_TIMEOUT_MS: {
    description: 'Timeout in milliseconds for the database probe used by the health endpoint.',
    default: '2000',
    example: '2000',
  },
  LOG_LEVEL: {
    description: 'Minimum log level emitted by the logger.',
    default: 'info',
    example: 'info',
  },
};

/** Deployed Folder contract on Stellar testnet (Indexer-Contract deployments/testnet.json). */
export const TESTNET_CONTRACT_ID = networkProfiles.testnet.contractId;
export const TESTNET_RPC_URL = networkProfiles.testnet.rpcUrl;
export const TESTNET_PASSPHRASE = networkProfiles.testnet.passphrase;

/** Network used when STELLAR_NETWORK is not set outside production. */
export const DEFAULT_STELLAR_NETWORK: StellarNetwork = 'testnet';

export function getNetworkProfile(network: StellarNetwork): NetworkProfile {
  return networkProfiles[network];
}

/** Returns the network whose profile owns the given passphrase, if any. */
function networkForPassphrase(passphrase: string): StellarNetwork | undefined {
  return STELLAR_NETWORKS.find((network) => networkProfiles[network].passphrase === passphrase);
}

/** Returns the network whose profile owns the given RPC URL, if any. */
function networkForRpcUrl(rpcUrl: string): StellarNetwork | undefined {
  const normalized = rpcUrl.replace(/\/+$/, '');
  return STELLAR_NETWORKS.find(
    (network) => networkProfiles[network].rpcUrl.replace(/\/+$/, '') === normalized
  );
}

/** Returns the network whose profile owns the given contract id, if any. */
function networkForContractId(contractId: string): StellarNetwork | undefined {
  return STELLAR_NETWORKS.find((network) => networkProfiles[network].contractId === contractId);
}

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development')
      .describe(envVarMeta.NODE_ENV.description),
    PORT: z.coerce
      .number()
      .int()
      .positive()
      .max(65535)
      .default(3000)
      .describe(envVarMeta.PORT.description),
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .describe(envVarMeta.DATABASE_URL.description),
    STELLAR_RPC_URL: z
      .string({ required_error: `STELLAR_RPC_URL is required (testnet: ${TESTNET_RPC_URL})` })
      .url('STELLAR_RPC_URL must be a valid URL')
      .describe(envVarMeta.STELLAR_RPC_URL.description),
    STELLAR_RPC_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10000)
      .describe(envVarMeta.STELLAR_RPC_TIMEOUT_MS.description),
    STELLAR_NETWORK_PASSPHRASE: z
      .string()
      .min(1)
      .default(TESTNET_PASSPHRASE)
      .describe(envVarMeta.STELLAR_NETWORK_PASSPHRASE.description),
    FOLDER_CONTRACT_ID: z
      .string()
      .refine(
        (value) => StrKey.isValidContract(value),
        'FOLDER_CONTRACT_ID must be a contract address (C..., 56 characters)'
      )
      .optional(),
    IPFS_API_URL: z.string().url('IPFS_API_URL must be a valid URL'),
    IPFS_API_AUTH: z.string().min(1).optional(),
    IPFS_GATEWAY: z.string().url('IPFS_GATEWAY must be a valid URL'),
    IPFS_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    CORS_ORIGIN: z
      .string()
      .optional()
      .transform((value) => value),
    REQUEST_BODY_LIMIT: z.string().default('1mb'),
    INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    INDEXER_PAGE_LIMIT: z.coerce.number().int().min(1).max(10000).default(200),
    INDEXER_START_LEDGER: optionalPositiveInt,
    INDEXER_ON_RETENTION_GAP: z.enum(['halt', 'skip']).default('halt'),
    INDEXER_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(60000),
    INDEXER_STALE_AFTER_MS: z.coerce.number().int().positive().default(120000),
    INDEXER_HTTP_PORT: z.coerce.number().int().positive().max(65535).default(3001),
    INDEXER_TICK_WINDOW_MULTIPLIER: z.coerce.number().int().min(1).default(3),
    DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    DATABASE_READ_URL: z
      .union([z.literal('').transform(() => undefined), z.string().url('DATABASE_READ_URL must be a valid URL')])
      .optional(),
    DB_REPLICA_MAX_LAG_MS: z.coerce.number().int().positive().default(5000),
    UPLOAD_DAILY_BYTES_QUOTA: optionalPositiveInt,
    UPLOAD_DAILY_FILE_QUOTA: optionalPositiveInt,
    UPLOAD_IP_HASH_SALT: z
      .union([z.literal('').transform(() => undefined), z.string().min(1)])
      .optional(),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    HEALTHCHECK_DATABASE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    PORTFOLIO_TRANSFERS_ENABLED: z
      .enum(['true', 'false', '1', '0'])
      .default('false')
      .transform((value) => value === 'true' || value === '1'),
  })
  .superRefine((env, ctx) => {
    const corsOrigin = env.CORS_ORIGIN;
    if (env.NODE_ENV === 'production' && !(corsOrigin !== undefined && corsOrigin.trim() !== '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN is required in production (comma-separated origins, or * to allow all)',
      });
    }

    if (env.NODE_ENV === 'production' && !env.STELLAR_NETWORK) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STELLAR_NETWORK'],
        message: `STELLAR_NETWORK is required in production (one of: ${STELLAR_NETWORKS.join(', ')})`,
      });
    }

    const network = env.STELLAR_NETWORK ?? DEFAULT_STELLAR_NETWORK;
    const profile = networkProfiles[network];

    if (env.STELLAR_NETWORK_PASSPHRASE) {
      const owner = networkForPassphrase(env.STELLAR_NETWORK_PASSPHRASE);
      if (owner !== network) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STELLAR_NETWORK_PASSPHRASE'],
          message:
            owner === undefined
              ? `STELLAR_NETWORK_PASSPHRASE does not match any known network profile (STELLAR_NETWORK=${network} expects "${profile.passphrase}")`
              : `STELLAR_NETWORK_PASSPHRASE belongs to the "${owner}" profile but STELLAR_NETWORK=${network}`,
        });
      }
    }

    if (env.STELLAR_RPC_URL) {
      const owner = networkForRpcUrl(env.STELLAR_RPC_URL);
      if (owner !== undefined && owner !== network) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STELLAR_RPC_URL'],
          message: `STELLAR_RPC_URL belongs to the "${owner}" profile but STELLAR_NETWORK=${network}`,
        });
      }
    }

    if (env.FOLDER_CONTRACT_ID) {
      const owner = networkForContractId(env.FOLDER_CONTRACT_ID);
      if (owner !== undefined && owner !== network) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FOLDER_CONTRACT_ID'],
          message: `FOLDER_CONTRACT_ID belongs to the "${owner}" profile but STELLAR_NETWORK=${network}`,
        });
      }
    }
  });

export type AppEnv = z.infer<typeof envSchema> & {
  /** Resolved network profile name (STELLAR_NETWORK or the default). */
  STELLAR_NETWORK: StellarNetwork;
  /** Resolved RPC URL (override or profile default). */
  STELLAR_RPC_URL: string;
  /** Resolved network passphrase (override or profile default). */
  STELLAR_NETWORK_PASSPHRASE: string;
  /** Resolved Folder contract id (override or profile default). */
  FOLDER_CONTRACT_ID: string;
};

/** Upload abuse-control settings; `null` when quotas are disabled. */
export interface UploadQuotaConfig {
  dailyBytesQuota: number | null;
  dailyFileQuota: number | null;
  ipHashSalt: string | null;
}

export function getUploadQuotaConfig(env: AppEnv = getEnv()): UploadQuotaConfig {
  return {
    dailyBytesQuota: env.UPLOAD_DAILY_BYTES_QUOTA ?? null,
    dailyFileQuota: env.UPLOAD_DAILY_FILE_QUOTA ?? null,
    ipHashSalt: env.UPLOAD_IP_HASH_SALT ?? null,
  };
}

let cachedEnv: AppEnv | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const { env, issues } = resolveSecretFiles(source);
  const parsed = envSchema.safeParse(env);

  const formatIssue = (issue: z.ZodIssue): string => {
    const field = issue.path.join('.');
    const message = isSecretField(issue.path) ? REDACTED : issue.message;
    return `${field}: ${message}`;
  };

  const details = [
    ...issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    ...(parsed.success ? [] : parsed.error.errors.map(formatIssue)),
  ];

  if (details.length > 0) {
    throw new Error(`Invalid environment configuration: ${details.join('; ')}. See docs/configuration.md`);
  }

  const network = parsed.data.STELLAR_NETWORK ?? DEFAULT_STELLAR_NETWORK;
  const profile = networkProfiles[network];

  return {
    ...parsed.data,
    STELLAR_NETWORK: network,
    STELLAR_RPC_URL: parsed.data.STELLAR_RPC_URL ?? profile.rpcUrl,
    STELLAR_NETWORK_PASSPHRASE: parsed.data.STELLAR_NETWORK_PASSPHRASE ?? profile.passphrase,
    FOLDER_CONTRACT_ID: parsed.data.FOLDER_CONTRACT_ID ?? profile.contractId,
  };
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

/**
 * Returns the configured log level without requiring full env validation.
 *
 * The logger may be used before `loadEnv()` runs (e.g. while reporting config
 * errors), so this reads `process.env.LOG_LEVEL` directly and falls back to the
 * schema default when the value is missing or invalid.
 */
export function getLogLevel(source: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = source.LOG_LEVEL?.trim().toLowerCase();
  if (raw && (LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return 'info';
}
