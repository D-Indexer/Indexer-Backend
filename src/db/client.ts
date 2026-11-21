import { Pool } from 'pg';
import { getEnv } from '../config/env';

const env = getEnv();

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_MAX_CONNECTIONS,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  // Server-side deadlines so a stuck statement or an abandoned transaction
  // cannot hold a connection (and its locks) forever.
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
});

export default pool;
