import { Client } from 'pg';

/**
 * Payload emitted on the `folder_indexed` Postgres channel after each
 * committed indexer page. See `src/indexer/stellar.ts`.
 *
 * Consumers MUST tolerate missed notifications (e.g. after a reconnect or
 * while disconnected) by re-reading authoritative state when they receive a
 * `resync` signal.
 */
export interface FolderIndexedPayload {
  /** The new `last_ledger` after the committed page. */
  last_ledger: number;
  /**
   * Compact list of affected entity keys (e.g. `folder:<id>`).
   * May be truncated; when truncated, `full_refresh` is set to `true`.
   */
  keys?: string[];
  /** When `true`, consumers should perform a full refresh. */
  full_refresh?: boolean;
}

/**
 * Event delivered to a `subscribeIndexed` handler.
 *
 * - `indexed`: a committed page produced a notification.
 * - `resync`: the listener (re)connected; consumers may have missed
 *   notifications and should re-read state.
 */
export type IndexedEvent =
  | { type: 'indexed'; payload: FolderIndexedPayload }
  | { type: 'resync'; reason: 'connected' | 'reconnected' };

export type IndexedHandler = (event: IndexedEvent) => void;

export interface SubscribeIndexedOptions {
  /**
   * Postgres connection string. Must be a direct (non-PgBouncer) connection:
   * LISTEN is session state. Defaults to `process.env.DATABASE_DIRECT_URL`,
   * then `process.env.DATABASE_URL`.
   */
  connectionString?: string;
  /** Base delay (ms) before reconnecting. Defaults to 1000. */
  reconnectBaseDelayMs?: number;
  /** Max delay (ms) between reconnect attempts. Defaults to 30000. */
  reconnectMaxDelayMs?: number;
  /** Optional logger. Defaults to `console`. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface IndexedSubscription {
  /** Stop listening and clean up the dedicated client. */
  stop(): Promise<void>;
}

const CHANNEL = 'folder_indexed';

function parsePayload(raw: string): FolderIndexedPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { last_ledger?: unknown }).last_ledger === 'number'
    ) {
      return parsed as FolderIndexedPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Subscribe to `folder_indexed` notifications using a dedicated,
 * auto-reconnecting `LISTEN` client.
 *
 * The handler is invoked with:
 * - `{ type: 'resync', reason: 'connected' }` on the initial connection,
 * - `{ type: 'indexed', payload }` for each committed page notification,
 * - `{ type: 'resync', reason: 'reconnected' }` after a dropped connection is
 *   re-established (notifications may have been missed while disconnected).
 *
 * Postgres delivers notifications only on commit, so a rolled-back page
 * produces no notification.
 */
export function subscribeIndexed(
  handler: IndexedHandler,
  options: SubscribeIndexedOptions = {},
): IndexedSubscription {
  const connectionString =
    options.connectionString ?? (process.env['DATABASE_DIRECT_URL'] || process.env['DATABASE_URL']);
  const baseDelay = options.reconnectBaseDelayMs ?? 1000;
  const maxDelay = options.reconnectMaxDelayMs ?? 30000;
  const logger = options.logger ?? console;

  let stopped = false;
  let client: Client | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let hasConnectedOnce = false;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    clearReconnectTimer();
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    // Do not keep the process alive solely for reconnects.
    if (typeof reconnectTimer.unref === 'function') {
      reconnectTimer.unref();
    }
  };

  const teardownClient = async (current: Client): Promise<void> => {
    current.removeAllListeners();
    try {
      await current.end();
    } catch {
      // Ignore errors while tearing down a broken client.
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;

    const current = new Client({ connectionString });
    client = current;

    let closed = false;
    const onClose = (): void => {
      if (closed) return;
      closed = true;
      if (client === current) {
        client = null;
      }
      if (stopped) return;
      logger.warn('[listen] folder_indexed connection closed; reconnecting');
      scheduleReconnect();
    };

    current.on('notification', (msg) => {
      if (stopped) return;
      if (msg.channel !== CHANNEL || !msg.payload) return;
      const payload = parsePayload(msg.payload);
      if (!payload) {
        logger.warn('[listen] ignoring malformed folder_indexed payload');
        return;
      }
      try {
        handler({ type: 'indexed', payload });
      } catch (err) {
        logger.error('[listen] handler threw on indexed event', err);
      }
    });

    current.on('error', (err) => {
      logger.warn('[listen] folder_indexed client error', err);
      // `end`/`error` will trigger reconnect via `onClose`.
      if (!closed) {
        void teardownClient(current).finally(onClose);
      }
    });

    current.on('end', onClose);

    try {
      await current.connect();
      if (stopped) {
        await teardownClient(current);
        return;
      }
      await current.query(`LISTEN ${CHANNEL}`);
      attempt = 0;
      const reason: 'connected' | 'reconnected' = hasConnectedOnce
        ? 'reconnected'
        : 'connected';
      hasConnectedOnce = true;
      try {
        handler({ type: 'resync', reason });
      } catch (err) {
        logger.error('[listen] handler threw on resync event', err);
      }
    } catch (err) {
      logger.warn('[listen] failed to establish folder_indexed listener', err);
      if (!closed) {
        closed = true;
        if (client === current) {
          client = null;
        }
        await teardownClient(current);
        scheduleReconnect();
      }
    }
  };

  void connect();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearReconnectTimer();
      const current = client;
      client = null;
      if (current) {
        await teardownClient(current);
      }
    },
  };
}