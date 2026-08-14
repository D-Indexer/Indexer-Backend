import { z } from 'zod';

const optionalUrl = z.string().url().optional().or(z.literal('').transform(() => undefined));

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  STELLAR_RPC_URL: z.string().url('STELLAR_RPC_URL must be a valid URL'),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1, 'STELLAR_NETWORK_PASSPHRASE is required'),
  FOLDER_CONTRACT_ID: z.string().min(1, 'FOLDER_CONTRACT_ID is required'),
  IPFS_API_URL: z.string().url('IPFS_API_URL must be a valid URL'),
  IPFS_GATEWAY: z.string().url('IPFS_GATEWAY must be a valid URL'),
  WEBHOOK_SECRET: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),
  REQUEST_BODY_LIMIT: z.string().default('1mb'),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  HEALTHCHECK_DATABASE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  PUBLIC_BASE_URL: optionalUrl,
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.errors
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
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
