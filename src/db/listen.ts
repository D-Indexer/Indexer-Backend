import { Pool, PoolClient } from 'pg';

/**
 * The Postgres NOTIFY channel used to broadcast indexed changes.
 *
 * Producers call `publish` inside the same transaction that commits the
 * outbox / page change, so subscribers only ever see notifications for
 * committed data.
 */
export const notifyChannel = 'indexed_changes';

/**
 * Payload shape broadcast over the NOTIFY channel.
 *
 * Keep this small: Postgres NOTIFY payloads are limited to 8000 bytes.
 * Consumers that need more detail should re-read from `contract_events`
 * using the cursor (`id`).
 */
export interface NotifyPayload {
  /** Monotonic cursor (event id / ledger cursor) used as the SSE `id`. */
  id: string | number;
  /** Topic(s) this change belongs to, e.g. "folder", "portfolio", "template". */
  topics?: string[];
  /** Owner address, if the change is scoped to a single user. */
  owner?: string | null;
  /** Optional event type, e.g. "mint", "update", "delete". */
  type?: string;
  /** Optional contract id. */
  contractId?: string | null;
  /** Optional ledger sequence. */
  ledger?: number | null;
  /** Optional timestamp (ISO string). */
  ts?: string;
}

/**
 * Publish a notification inside the caller's transaction.
 *
 * Must be called with the same `PoolClient` that is performing the page
 * commit so the NOTIFY is delivered atomically with the data change.
 */
export async function publish(
  client: PoolClient,
  payload: NotifyPayload,
): Promise<void> {
  const body = JSON.stringify(payload);
  // pg_notify takes the channel and payload as text parameters, which avoids
  // any quoting/escaping issues with dynamic SQL.
  await client.query('SELECT pg_notify($1, $2)', [notifyChannel, body]);
}

export type NotifyHandler = (payload: NotifyPayload) => void;

export interface SubscribeOptions {
  /** Initial reconnect delay in ms (default 500). */
  initialReconnectDelayMs?: number;
  /** Maximum reconnect delay in ms (default 30000). */
  maxReconnectDelayMs?: number;
  /** Optional logger. */
  logger?: Pick<Console, 'warn' | 'error' | 'info'>;
}

/**
 * Subscribe to the NOTIFY channel using a dedicated listener client.
 *
 * Returns an unsubscribe function that stops the listener and releases the
 * client. The listener automatically reconnects with exponential backoff if
 * the underlying connection drops.
 */
export function subscribe(
  pool: Pool,
  handler: NotifyHandler,
  options: SubscribeOptions = {},
): () => void {
  const {
    initialReconnectDelayMs = 500,
    maxReconnectDelayMs = 30_000,
    logger = console,
  } = options;

  let closed = false;
  let client: PoolClient | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectDelay = initialReconnectDelayMs;

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    clearReconnectTimer();
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelayMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    // Don't keep the process alive solely for a reconnect timer.
    if (typeof reconnectTimer.unref === 'function') {
      reconnectTimer.unref();
    }
  };

  const handleNotification = (msg: {
    channel: string;
    payload?: string;
  }) => {
    if (msg.channel !== notifyChannel || !msg.payload) return;
    let parsed: NotifyPayload;
    try {
      parsed = JSON.parse(msg.payload) as NotifyPayload;
    } catch (err) {
      logger.warn?.(
        `[listen] failed to parse NOTIFY payload on ${notifyChannel}:`,
        err,
      );
      return;
    }
    try {
      handler(parsed);
    } catch (err) {
      logger.error?.(`[listen] handler threw for ${notifyChannel}:`, err);
    }
  };

  const cleanupClient = () => {
    if (!client) return;
    const c = client;
    client = null;
    c.removeListener('notification', handleNotification);
    c.removeListener('error', onError);
    c.removeListener('end', onEnd);
    // Release back to the pool; ignore errors on an already-broken client.
    try {
      c.release(true);
    } catch {
      /* ignore */
    }
  };

  const onError = (err: Error) => {
    if (closed) return;
    logger.warn?.(`[listen] connection error on ${notifyChannel}:`, err);
    cleanupClient();
    scheduleReconnect();
  };

  const onEnd = () => {
    if (closed) return;
    logger.warn?.(`[listen] connection ended on ${notifyChannel}`);
    cleanupClient();
    scheduleReconnect();
  };

  const connect = async () => {
    if (closed) return;
    try {
      const c = await pool.connect();
      if (closed) {
        c.release();
        return;
      }
      client = c;
      c.on('notification', handleNotification);
      c.on('error', onError);
      c.on('end', onEnd);
      await c.query(`LISTEN ${notifyChannel}`);
      // Reset backoff after a successful (re)connect.
      reconnectDelay = initialReconnectDelayMs;
      logger.info?.(`[listen] subscribed to ${notifyChannel}`);
    } catch (err) {
      logger.warn?.(`[listen] failed to subscribe to ${notifyChannel}:`, err);
      cleanupClient();
      scheduleReconnect();
    }
  };

  void connect();

  return function unsubscribe() {
    if (closed) return;
    closed = true;
    clearReconnectTimer();
    if (client) {
      const c = client;
      client = null;
      c.removeListener('notification', handleNotification);
      c.removeListener('error', onError);
      c.removeListener('end', onEnd);
      // Best-effort UNLISTEN then release.
      c.query(`UNLISTEN ${notifyChannel}`)
        .catch(() => {
          /* ignore */
        })
        .finally(() => {
          try {
            c.release();
          } catch {
            /* ignore */
          }
        });
    }
  };
}