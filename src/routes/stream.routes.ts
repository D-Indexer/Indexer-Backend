import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { subscribe, Unsubscribe } from '../db/listen';
import { logger } from '../logger';

export const streamRouter = Router();

const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 5;

const MAX_CONNECTIONS_PER_IP = (() => {
  const raw = process.env.STREAM_MAX_CONNECTIONS_PER_IP;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONNECTIONS_PER_IP;
})();

interface StreamClient {
  id: number;
  ip: string;
  res: Response;
  heartbeat: NodeJS.Timeout;
  unsubscribe: Unsubscribe | null;
  closed: boolean;
}

let nextClientId = 1;
const clients = new Set<StreamClient>();
const connectionsByIp = new Map<string, number>();

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function parseTopics(raw: unknown): Set<string> | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const value = Array.isArray(raw) ? raw.join(',') : String(raw);
  const topics = value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return topics.length > 0 ? new Set(topics) : null;
}

function parseOwner(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const value = Array.isArray(raw) ? raw[0] : String(raw);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCursor(raw: unknown): bigint | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const value = Array.isArray(raw) ? raw[0] : String(raw);
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

interface ContractEventRow {
  id: string | number | bigint;
  topic: string;
  owner: string | null;
  ledger: number | string | bigint;
  payload: unknown;
  created_at?: string | Date | null;
}

function eventMatches(
  row: ContractEventRow,
  topics: Set<string> | null,
  owner: string | null,
): boolean {
  if (topics && !topics.has(row.topic)) {
    return false;
  }
  if (owner && row.owner !== owner) {
    return false;
  }
  return true;
}

function writeEvent(
  res: Response,
  row: ContractEventRow,
): void {
  const id = String(row.id);
  const data = JSON.stringify({
    id,
    topic: row.topic,
    owner: row.owner,
    ledger: typeof row.ledger === 'bigint' ? row.ledger.toString() : row.ledger,
    payload: row.payload,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
  });
  res.write(`id: ${id}\n`);
  res.write(`event: ${row.topic}\n`);
  res.write(`data: ${data}\n\n`);
}

function writeHeartbeat(res: Response): void {
  res.write(`: heartbeat ${Date.now()}\n\n`);
}

async function replayMissedEvents(
  res: Response,
  cursor: bigint,
  topics: Set<string> | null,
  owner: string | null,
): Promise<bigint> {
  let lastId = cursor;
  const result = await pool.query<ContractEventRow>(
    `SELECT id, topic, owner, ledger, payload, created_at
       FROM contract_events
      WHERE id > $1
      ORDER BY id ASC`,
    [cursor.toString()],
  );
  for (const row of result.rows) {
    if (!eventMatches(row, topics, owner)) {
      continue;
    }
    writeEvent(res, row);
    const rowId = BigInt(String(row.id));
    if (rowId > lastId) {
      lastId = rowId;
    }
  }
  return lastId;
}

function cleanupClient(client: StreamClient): void {
  if (client.closed) {
    return;
  }
  client.closed = true;
  clearInterval(client.heartbeat);
  if (client.unsubscribe) {
    try {
      client.unsubscribe();
    } catch (err) {
      logger.warn({ err }, 'stream: failed to unsubscribe client');
    }
    client.unsubscribe = null;
  }
  clients.delete(client);
  const count = connectionsByIp.get(client.ip) ?? 0;
  if (count <= 1) {
    connectionsByIp.delete(client.ip);
  } else {
    connectionsByIp.set(client.ip, count - 1);
  }
}

function closeClient(client: StreamClient): void {
  cleanupClient(client);
  try {
    client.res.end();
  } catch {
    // ignore
  }
}

streamRouter.get('/stream', async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const current = connectionsByIp.get(ip) ?? 0;
  if (current >= MAX_CONNECTIONS_PER_IP) {
    res.status(429).json({
      error: 'too_many_connections',
      message: `Maximum of ${MAX_CONNECTIONS_PER_IP} concurrent stream connections per IP exceeded`,
    });
    return;
  }

  const topics = parseTopics(req.query.topics);
  const owner = parseOwner(req.query.owner);

  const lastEventIdHeader = req.headers['last-event-id'];
  const headerCursor = parseCursor(Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader);
  const queryCursor = parseCursor(req.query.lastEventId);
  const cursor = headerCursor ?? queryCursor;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders?.();
  if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
    (res as unknown as { flush: () => void }).flush();
  }

  const client: StreamClient = {
    id: nextClientId++,
    ip,
    res,
    heartbeat: setInterval(() => {
      if (client.closed) {
        return;
      }
      try {
        writeHeartbeat(res);
      } catch (err) {
        logger.warn({ err }, 'stream: heartbeat write failed');
        closeClient(client);
      }
    }, HEARTBEAT_INTERVAL_MS),
    unsubscribe: null,
    closed: false,
  };
  if (typeof client.heartbeat.unref === 'function') {
    client.heartbeat.unref();
  }

  clients.add(client);
  connectionsByIp.set(ip, current + 1);

  req.on('close', () => cleanupClient(client));
  req.on('aborted', () => cleanupClient(client));
  res.on('close', () => cleanupClient(client));
  res.on('error', () => cleanupClient(client));

  // Replay missed events before subscribing to live updates.
  if (cursor !== null) {
    try {
      await replayMissedEvents(res, cursor, topics, owner);
    } catch (err) {
      logger.error({ err }, 'stream: failed to replay missed events');
      closeClient(client);
      return;
    }
  }

  if (client.closed) {
    return;
  }

  try {
    client.unsubscribe = subscribe((event) => {
      if (client.closed) {
        return;
      }
      const row = event as unknown as ContractEventRow;
      if (!eventMatches(row, topics, owner)) {
        return;
      }
      try {
        writeEvent(res, row);
      } catch (err) {
        logger.warn({ err }, 'stream: failed to write event');
        closeClient(client);
      }
    });
  } catch (err) {
    logger.error({ err }, 'stream: failed to subscribe client');
    closeClient(client);
    return;
  }

  // Initial comment to establish the stream promptly.
  try {
    res.write(': connected\n\n');
  } catch (err) {
    logger.warn({ err }, 'stream: initial write failed');
    closeClient(client);
  }
});

export function closeAllStreams(): void {
  for (const client of Array.from(clients)) {
    closeClient(client);
  }
}

let shutdownRegistered = false;

export function registerStreamShutdownHandlers(): void {
  if (shutdownRegistered) {
    return;
  }
  shutdownRegistered = true;
  const handler = (signal: string) => {
    logger.info({ signal }, 'stream: closing all connections');
    closeAllStreams();
  };
  process.once('SIGTERM', () => handler('SIGTERM'));
  process.once('SIGINT', () => handler('SIGINT'));
}

registerStreamShutdownHandlers();

export default streamRouter;