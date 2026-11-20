import { Pool } from 'pg';
import { getEnv } from '../config/env';

const env = getEnv();

function resolveConnectionString(): string {
  const processRole = (process.env.PROCESS_ROLE ?? '').toLowerCase();

  if (processRole === 'api') {
    return env.API_DATABASE_URL ?? env.DATABASE_URL;
  }

  if (processRole === 'indexer') {
    return env.INDEXER_DATABASE_URL ?? env.DATABASE_URL;
  }

  return env.DATABASE_URL;
}

const pool = new Pool({
  connectionString: resolveConnectionString(),
  max: env.DB_MAX_CONNECTIONS,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
});

export default pool;