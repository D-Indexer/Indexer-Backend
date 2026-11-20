import { Pool } from 'pg';
import type { AppEnv } from '../config/env';

export type PoolEnv = Pick<
  AppEnv,
  'DATABASE_URL' | 'DB_MAX_CONNECTIONS' | 'DB_IDLE_TIMEOUT_MS' | 'DB_CONNECTION_TIMEOUT_MS'
>;

export function createPool(env: PoolEnv): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_MAX_CONNECTIONS,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });
}