import { Pool } from 'pg';
import { getEnv } from '../config/env';

const env = getEnv();

const isTest = env.NODE_ENV === 'test';
const workerId = process.env.JEST_WORKER_ID;

// In test mode, each Jest worker gets its own schema (test_<workerId>) so that
// Postgres-backed tests can run in parallel without seeing each other's rows.
// We set search_path on every connection via the connection `options` parameter.
const searchPathOptions =
  isTest && workerId ? `-c search_path=test_${workerId},public` : undefined;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_MAX_CONNECTIONS,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  ...(searchPathOptions ? { options: searchPathOptions } : {}),
});

export default pool;