import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import networksJson from './networks.json';

const optionalPositiveInt = z
  .union([z.literal('').transform(() => undefined), z.coerce.number().int().positive()])
  .optional();

export const STELLAR_NETWORKS = ['testnet', 'mainnet', 'futurenet', 'local'] as const;
export type StellarNetwork = (typeof STELLAR_NETWORKS)[number];

export interface NetworkProfile {
  passphrase: string;
  rpcUrl: string;
  contractId: string;
}

const networkProfiles = networksJson as Record<StellarNetwork, NetworkProfile>;

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

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    STELLAR_NETWORK: z.enum(STELLAR_NETWORKS).optional(),
    STELLAR_RPC_URL: z.string().url('STELLAR_RPC_URL must be a valid URL').optional(),
    STELLAR_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    STELLAR_NETWORK_PASSPHRASE: z.string().min(1).optional(),
    FOLDER_CONTRACT_ID: z
      .string()
      .refine(
        (value) => StrKey.isValidContract(value),
        'FOLDER_CONTRACT_ID must be a contract address (C..., 56 characters)'
      )
      .optional(),
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
    if (env.NODE_ENV === 'production' && !env.CORS_ORIGIN?.trim()) {
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

let cachedEnv: AppEnv | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.errors
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}. See docs/configuration.md`);
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

/** Resolved network name for the current environment (safe to call from routes). */
export function getStellarNetwork(): StellarNetwork {
  return getEnv().STELLAR_NETWORK;
}
