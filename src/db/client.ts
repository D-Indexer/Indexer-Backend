import { Pool, PoolClient } from 'pg';
import { getEnv } from '../config/env';

const env = getEnv();

function redactError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Never leak the connection string (which may contain credentials) into logs.
  return message.replace(/postgres(ql)?:\/\/[^\s]+/gi, 'postgres://[redacted]');
}

function createPool(connectionString: string, label: string): Pool {
  const p = new Pool({
    connectionString,
    max: env.DB_MAX_CONNECTIONS,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });

  // Without an 'error' listener, pg emits an unhandled 'error' event when an idle
  // backend is terminated (failover, restart, idle_session_timeout, network reset)
  // and Node crashes the process. Log and let the pool discard the client.
  p.on('error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.error(`[db:${label}] idle client error: ${redactError(err)}`);
  });

  return p;
}

const pool = createPool(env.DATABASE_URL, 'primary');

const readPool: Pool | null = env.DATABASE_READ_URL
  ? createPool(env.DATABASE_READ_URL, 'read')
  : null;

export default pool;

export function getReadPool(): Pool | null {
  return readPool;
}

// ---------------------------------------------------------------------------
// Replica lag probe
// ---------------------------------------------------------------------------

export interface LagProbeResult {
  lagMs: number;
  lastLedger: number | null;
}

export type LagProbe = () => Promise<LagProbeResult>;

const defaultLagProbe: LagProbe = async () => {
  if (!readPool) {
    return { lagMs: 0, lastLedger: null };
  }
  const client = await readPool.connect();
  try {
    const lagRes = await client.query<{ lag_ms: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms`,
    );
    const rawLag = lagRes.rows[0]?.lag_ms;
    const lagMs = rawLag === null || rawLag === undefined ? 0 : Number(rawLag);

    let lastLedger: number | null = null;
    try {
      const stateRes = await client.query<{ last_ledger: string | number | null }>(
        `SELECT last_ledger FROM indexer_state LIMIT 1`,
      );
      const rawLedger = stateRes.rows[0]?.last_ledger;
      lastLedger = rawLedger === null || rawLedger === undefined ? null : Number(rawLedger);
    } catch {
      // indexer_state may not exist yet; treat as unknown.
      lastLedger = null;
    }

    return { lagMs: Number.isFinite(lagMs) ? lagMs : 0, lastLedger };
  } finally {
    client.release();
  }
};

let lagProbe: LagProbe = defaultLagProbe;

/** Override the lag probe (used by tests). Pass null to restore the default. */
export function setLagProbe(probe: LagProbe | null): void {
  lagProbe = probe ?? defaultLagProbe;
}

export function getLagProbe(): LagProbe {
  return lagProbe;
}

// ---------------------------------------------------------------------------
// Pool selection
// ---------------------------------------------------------------------------

export interface ReadPoolOptions {
  minLedger?: number | null;
}

/**
 * Select the pool to use for a read.
 *
 * - Without DATABASE_READ_URL, always returns the primary.
 * - With a replica, falls back to the primary when the replica lag exceeds
 *   DB_REPLICA_MAX_LAG_MS, or when the caller requires read-your-writes
 *   (minLedger) and the replica's indexer_state.last_ledger is behind.
 */
export async function selectReadPool(options: ReadPoolOptions = {}): Promise<Pool> {
  if (!readPool) {
    return pool;
  }

  let result: LagProbeResult;
  try {
    result = await lagProbe();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[db:read] lag probe failed, using primary: ${redactError(err)}`);
    return pool;
  }

  if (result.lagMs > env.DB_REPLICA_MAX_LAG_MS) {
    return pool;
  }

  const minLedger = options.minLedger;
  if (minLedger !== null && minLedger !== undefined) {
    if (result.lastLedger === null || result.lastLedger < minLedger) {
      return pool;
    }
  }

  return readPool;
}

/** Convenience helper: acquire a client from the appropriate read pool. */
export async function connectForRead(
  options: ReadPoolOptions = {},
): Promise<PoolClient> {
  const selected = await selectReadPool(options);
  return selected.connect();
}

// ---------------------------------------------------------------------------
// Long-lived dedicated clients (advisory lock, LISTEN) with reconnect logic
// ---------------------------------------------------------------------------

export interface DedicatedClientOptions {
  /** Label used in log messages. */
  name: string;
  /** Called after a successful (re)connect. */
  onConnect?: (client: PoolClient) => Promise<void> | void;
  /** Base delay in ms between reconnect attempts (exponential backoff). */
  reconnectBaseDelayMs?: number;
  /** Maximum delay in ms between reconnect attempts. */
  reconnectMaxDelayMs?: number;
}

export interface DedicatedClient {
  /** Current underlying client, or null while disconnected. */
  getClient(): PoolClient | null;
  /** Stop reconnecting and release the client. */
  close(): Promise<void>;
}

/**
 * Acquire a dedicated client from the primary pool that survives idle backend
 * termination. On 'error' the client is discarded and a new one is acquired
 * with exponential backoff, invoking onConnect each time.
 */
export function createDedicatedClient(options: DedicatedClientOptions): DedicatedClient {
  const baseDelay = options.reconnectBaseDelayMs ?? 500;
  const maxDelay = options.reconnectMaxDelayMs ?? 30_000;

  let current: PoolClient | null = null;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let attempt = 0;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') {
      reconnectTimer.unref();
    }
  };

  const handleClientError = (err: Error) => {
    // eslint-disable-next-line no-console
    console.error(`[db:${options.name}] dedicated client error: ${redactError(err)}`);
    if (current) {
      const dead = current;
      current = null;
      try {
        dead.release(true);
      } catch {
        // ignore
      }
    }
    scheduleReconnect();
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    try {
      const client = await pool.connect();
      if (closed) {
        client.release();
        return;
      }
      current = client;
      attempt = 0;
      client.on('error', handleClientError);
      if (options.onConnect) {
        await options.onConnect(client);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[db:${options.name}] connect failed: ${redactError(err)}`);
      scheduleReconnect();
    }
  };

  void connect();

  return {
    getClient() {
      return current;
    },
    async close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (current) {
        const c = current;
        current = null;
        try {
          c.removeListener('error', handleClientError);
          c.release();
        } catch {
          // ignore
        }
      }
    },
  };
}