import { Pool, type PoolConfig } from 'pg';
import { getEnv, getDirectDatabaseUrl } from '../config/env';
import cache from '../cache';

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

const CACHE_INVALIDATE_CHANNEL = 'cache_invalidate';

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30000;

let listenClient: Client | null = null;
let listenStarted = false;
let listenDown = false;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

/**
 * Whether the dedicated LISTEN connection is currently up.
 * When false, the cache falls back to TTL-based expiry.
 */
export function isListenUp(): boolean {
  return listenStarted && !listenDown && listenClient !== null;
}

function parseTags(payload: string | undefined): string[] {
  if (!payload) {
    return [];
  }
  return payload
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function handleNotification(payload: string | undefined): void {
  const tags = parseTags(payload);
  if (tags.length === 0) {
    // Empty payload means "invalidate everything".
    cache.flush();
    return;
  }
  for (const tag of tags) {
    cache.invalidateTag(tag);
  }
}

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) {
    return;
  }
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts,
    RECONNECT_MAX_DELAY_MS,
  );
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectListener();
  }, delay);
  // Do not keep the process alive solely for reconnects.
  if (typeof reconnectTimer.unref === 'function') {
    reconnectTimer.unref();
  }
}

function markDown(client: Client): void {
  if (listenClient !== client) {
    return;
  }
  listenDown = true;
  listenClient = null;
  try {
    client.removeAllListeners();
    void client.end().catch(() => {
      /* ignore */
    });
  } catch {
    /* ignore */
  }
  scheduleReconnect();
}

async function connectListener(): Promise<void> {
  if (shuttingDown) {
    return;
  }

  // LISTEN is session state: it must use a direct connection, never a
  // transaction-mode PgBouncer (see docs/database-connections.md).
  const client = new Client({ connectionString: getDirectDatabaseUrl(env) });
  listenClient = client;

  client.on('notification', (msg) => {
    if (msg.channel === CACHE_INVALIDATE_CHANNEL) {
      handleNotification(msg.payload);
    }
  });

  client.on('error', () => {
    markDown(client);
  });

  client.on('end', () => {
    markDown(client);
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${CACHE_INVALIDATE_CHANNEL}`);
    if (listenClient !== client) {
      // Was torn down while connecting.
      return;
    }
    listenDown = false;
    reconnectAttempts = 0;
    // Flush on (re)connect to avoid serving entries that may have gone
    // stale while the LISTEN connection was down.
    cache.flush();
  } catch {
    markDown(client);
  }
}

/**
 * Start the dedicated LISTEN connection used for cache invalidation.
 * Safe to call multiple times; only the first call has an effect.
 */
export function startCacheInvalidationListener(): void {
  if (listenStarted || shuttingDown) {
    return;
  }
  listenStarted = true;
  void connectListener();
}

/**
 * Stop the LISTEN connection and cancel any pending reconnect.
 */
export async function stopCacheInvalidationListener(): Promise<void> {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const client = listenClient;
  listenClient = null;
  listenDown = true;
  if (client) {
    try {
      client.removeAllListeners();
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Publish a NOTIFY message on the cache invalidation channel.
 * `tags` are joined with commas; an empty list invalidates everything.
 */
export async function publishCacheInvalidation(tags: string[]): Promise<void> {
  const payload = tags.join(',');
  await pool.query('SELECT pg_notify($1, $2)', [
    CACHE_INVALIDATE_CHANNEL,
    payload,
  ]);
}
