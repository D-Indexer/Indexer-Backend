import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

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
export const TESTNET_CONTRACT_ID = 'CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV';
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

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
      .string({ required_error: `FOLDER_CONTRACT_ID is required (testnet: ${TESTNET_CONTRACT_ID})` })
      .refine(
        (value) => StrKey.isValidContract(value),
        'FOLDER_CONTRACT_ID must be a contract address (C..., 56 characters)'
      ),
    IPFS_API_URL: z.string().url('IPFS_API_URL must be a valid URL'),
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
    DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    HEALTHCHECK_DATABASE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
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
