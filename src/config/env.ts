import { StrKey } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const optionalPositiveInt = z
  .union([z.literal('').transform(() => undefined), z.coerce.number().int().positive()])
  .optional();

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
      .url('STELLAR_RPC_URL must be a valid URL')
      .optional(),
    /** Comma-separated RPC endpoints, tried in order. Takes precedence over STELLAR_RPC_URL. */
    STELLAR_RPC_URLS: z.string().optional(),
    STELLAR_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    /** Consecutive failures before an endpoint is skipped for the cool-down. */
    STELLAR_RPC_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
    STELLAR_RPC_COOLDOWN_MS: z.coerce.number().int().positive().default(60000),
    /** JSON object of extra HTTP headers sent with every RPC request (e.g. paid provider API keys). */
    STELLAR_RPC_HEADERS: z.string().optional(),
    /** Path to a JSON file with the same shape as STELLAR_RPC_HEADERS; merged over it. */
    STELLAR_RPC_HEADERS_FILE: z.string().optional(),
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
    const urls = parseRpcUrls(env.STELLAR_RPC_URLS);
    if (urls.length === 0 && !env.STELLAR_RPC_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STELLAR_RPC_URL'],
        message: `STELLAR_RPC_URL is required (testnet: ${TESTNET_RPC_URL})`,
      });
    }
    for (const url of urls) {
      if (!z.string().url().safeParse(url).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STELLAR_RPC_URLS'],
          message: `STELLAR_RPC_URLS contains an invalid URL: ${url}`,
        });
      }
    }
    for (const key of ['STELLAR_RPC_HEADERS', 'STELLAR_RPC_HEADERS_FILE'] as const) {
      const raw = env[key];
      if (raw === undefined || raw.trim() === '') continue;
      const result = parseRpcHeaders(raw);
      if (!result.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} ${result.error}` });
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

/** Split a comma-separated endpoint list, dropping blanks and duplicates. */
export function parseRpcUrls(value: string | undefined): string[] {
  if (!value) return [];
  const urls = value
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return [...new Set(urls)];
}

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

export type RpcHeadersResult = { ok: true; headers: Record<string, string> } | { ok: false; error: string };

/**
 * Parse a JSON object of RPC headers. Error messages never include header
 * values, so a malformed config cannot leak an API key into logs.
 */
export function parseRpcHeaders(raw: string): RpcHeadersResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'must be a JSON object of header name/value pairs' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'must be a JSON object of header name/value pairs' };
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!HEADER_NAME_RE.test(name)) {
      return { ok: false, error: `contains an invalid header name: ${JSON.stringify(name)}` };
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      return { ok: false, error: `must not set the ${name} header` };
    }
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: `header ${name} must have a non-empty string value` };
    }
    if (/[\r\n]/.test(value)) {
      return { ok: false, error: `header ${name} must not contain line breaks` };
    }
    headers[name] = value;
  }
  return { ok: true, headers };
}

/** All configured RPC endpoints, primary first. */
export function rpcUrls(env: Pick<AppEnv, 'STELLAR_RPC_URL' | 'STELLAR_RPC_URLS'>): string[] {
  const urls = parseRpcUrls(env.STELLAR_RPC_URLS);
  if (urls.length > 0) return urls;
  return env.STELLAR_RPC_URL ? [env.STELLAR_RPC_URL] : [];
}

let cachedEnv: AppEnv | null = null;

/**
 * Resolve the headers sent with every RPC request: STELLAR_RPC_HEADERS merged
 * with the JSON file at STELLAR_RPC_HEADERS_FILE (file wins). Throws without
 * echoing header values when the configuration is invalid.
 */
export function rpcHeaders(
  env: Pick<AppEnv, 'STELLAR_RPC_HEADERS' | 'STELLAR_RPC_HEADERS_FILE'>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')
): Record<string, string> {
  const headers: Record<string, string> = {};
  const sources: Array<[string, string | undefined]> = [
    ['STELLAR_RPC_HEADERS', env.STELLAR_RPC_HEADERS],
    ['STELLAR_RPC_HEADERS_FILE', env.STELLAR_RPC_HEADERS_FILE],
  ];
  for (const [key, raw] of sources) {
    if (raw === undefined || raw.trim() === '') continue;
    let content = raw;
    if (key === 'STELLAR_RPC_HEADERS_FILE') {
      try {
        content = readFile(raw.trim());
      } catch {
        throw new Error(`Invalid environment configuration: ${key} could not be read. See docs/configuration.md`);
      }
    }
    const result = parseRpcHeaders(content);
    if (!result.ok) {
      throw new Error(`Invalid environment configuration: ${key} ${result.error}. See docs/configuration.md`);
    }
    Object.assign(headers, result.headers);
  }
  return headers;
}

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
