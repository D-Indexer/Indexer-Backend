import { Pool } from 'pg';
import { loadEnv, type Env } from './config/env';
import { createRpcClient, type RpcClient } from './rpc/client';
import { createFolderService, type FolderService } from './services/folder.service';
import { createPortfolioService, type PortfolioService } from './services/portfolio.service';
import { createTemplateService, type TemplateService } from './services/template.service';
import { createIpfsService, type IpfsService } from './services/ipfs';

/**
 * The composition root.
 *
 * This is the only module (besides entrypoints such as `server.ts` and
 * `indexer/main.ts`) allowed to read environment variables. Everything else
 * receives its dependencies explicitly, which keeps modules importable with an
 * empty environment and makes it possible to build multiple, independently
 * configured app instances.
 */

export interface Container {
  env: Env;
  pool: Pool;
  rpc: RpcClient;
  folderService: FolderService;
  portfolioService: PortfolioService;
  templateService: TemplateService;
  ipfsService: IpfsService;
}

/**
 * Dependencies required by `createApp(deps)` and `createIndexer(deps)`.
 */
export interface AppDeps {
  env: Env;
  pool: Pool;
  rpc: RpcClient;
  folderService: FolderService;
  portfolioService: PortfolioService;
  templateService: TemplateService;
  ipfsService: IpfsService;
}

/**
 * Builds the full dependency graph from an explicit environment source.
 *
 * @param source Environment variables to load configuration from. Defaults to
 *   `process.env`, but callers (notably tests) may pass any object.
 */
export function createContainer(source: NodeJS.ProcessEnv = process.env): Container {
  const env = loadEnv(source);

  const pool = new Pool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    max: env.DB_POOL_MAX,
  });

  const rpc = createRpcClient({
    url: env.RPC_URL,
    timeoutMs: env.RPC_TIMEOUT_MS,
  });

  const folderService = createFolderService({ db: pool });
  const portfolioService = createPortfolioService({ db: pool, rpc });
  const templateService = createTemplateService({ db: pool });
  const ipfsService = createIpfsService({ url: env.IPFS_URL });

  return {
    env,
    pool,
    rpc,
    folderService,
    portfolioService,
    templateService,
    ipfsService,
  };
}

/**
 * Convenience helper for tests: builds a container from a base environment
 * with the given overrides applied. No global `process.env` mutation occurs.
 */
export function createTestContainer(overrides: Partial<NodeJS.ProcessEnv> = {}): Container {
  const source: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  return createContainer(source);
}

/**
 * Extracts the dependency object consumed by `createApp` / `createIndexer`
 * from a container.
 */
export function toAppDeps(container: Container): AppDeps {
  return {
    env: container.env,
    pool: container.pool,
    rpc: container.rpc,
    folderService: container.folderService,
    portfolioService: container.portfolioService,
    templateService: container.templateService,
    ipfsService: container.ipfsService,
  };
}