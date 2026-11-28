import { Pool, type PoolConfig } from 'pg';
import { getEnv } from '../config/env';

export type PoolEnv = Pick<
  AppEnv,
  'DATABASE_URL' | 'DB_MAX_CONNECTIONS' | 'DB_IDLE_TIMEOUT_MS' | 'DB_CONNECTION_TIMEOUT_MS'
>;

const poolConfig: PoolConfig = {
  connectionString: env.DATABASE_URL,
  max: env.DB_MAX_CONNECTIONS,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
};

const pool = new Pool(poolConfig);

export default pool;
