import { readFileSync } from 'node:fs';
import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

const optionalPositiveInt = z
  .union([z.literal('').transform(() => undefined), z.coerce.number().int().positive()])
  .optional();

/**
 * Environment variables that carry secrets. For each of these, a `<NAME>_FILE`
 * variant may be supplied instead, pointing to a file whose trimmed content is
 * used as the value (Docker/Kubernetes secret convention).
 */
export const SECRET_ENV_VARS = ['DATABASE_URL', 'IPFS_API_AUTH'] as const;
export type SecretEnvVar = (typeof SECRET_ENV_VARS)[number];

const REDACTED = '[redacted]';

function isSecretField(path: readonly (string | number)[]): boolean {
  const [field] = path;
  return typeof field === 'string' && (SECRET_ENV_VARS as readonly string[]).includes(field);
}

/**
 * Resolves `<NAME>_FILE` secret files into their corresponding env vars.
 * Returns a shallow copy of `source` with resolved values and a list of
 * configuration issues (conflicts, unreadable files) to surface via Zod.
 */
function resolveSecretFiles(source: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  issues: { path: string[]; message: string }[];
} {
  const env: NodeJS.ProcessEnv = { ...source };
  const issues: { path: string[]; message: string }[] = [];

  for (const name of SECRET_ENV_VARS) {
    const fileVar = `${name}_FILE`;
    const filePath = source[fileVar]?.trim();
    const directValue = source[name];

    if (!filePath) {
      continue;
    }

    if (directValue !== undefined && directValue !== '') {
      issues.push({
        path: [name],
        message: `Set either ${name} or ${fileVar}, not both`,
      });
      continue;
    }

    try {
      const content = readFileSync(filePath, 'utf8').trim();
      if (!content) {
        issues.push({
          path: [name],
          message: `${fileVar} points to an empty file (${filePath})`,
        });
        continue;
      }
      env[name] = content;
    } catch {
      issues.push({
        path: [name],
        message: `${fileVar} could not be read (${filePath})`,
      });
    }
  }

  return { env, issues };
}

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
    IPFS_API_AUTH: z.string().min(1).optional(),
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
