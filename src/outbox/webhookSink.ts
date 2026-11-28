import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';

/**
 * Outbox row shape consumed by the webhook sink.
 */
export interface OutboxRow {
  id: string | number;
  topic: string;
  payload: unknown;
  owner?: string | null;
  created_at?: Date | string;
}

export interface WebhookSubscription {
  id: string | number;
  url: string;
  topics: string[];
  owner_filter: string | null;
  secret: string;
  active: boolean;
  consecutive_failures: number;
}

export interface WebhookSinkOptions {
  /** Number of consecutive failures before a subscription is disabled. Default 10. */
  failureThreshold?: number;
  /** Request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Injectable DNS resolver (for tests). Defaults to dns.promises.lookup. */
  resolveHost?: (hostname: string) => Promise<{ address: string; family: number }>;
  /** Injectable clock (for tests). Defaults to Date.now. */
  now?: () => number;
  /** Injectable id generator (for tests). Defaults to randomUUID. */
  generateId?: () => string;
}

export interface DeliveryResult {
  subscriptionId: string | number;
  eventId: string;
  ok: boolean;
  statusCode?: number;
  error?: string;
}

export interface WebhookSink {
  /** Deliver a single outbox row to all matching active subscriptions. */
  deliver(row: OutboxRow): Promise<DeliveryResult[]>;
  /** Process a batch of outbox rows. */
  deliverBatch(rows: OutboxRow[]): Promise<DeliveryResult[]>;
}

const DEFAULT_FAILURE_THRESHOLD = 10;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Compute the signature for a webhook delivery.
 * Algorithm: HMAC-SHA256(secret, `${timestamp}.${body}`) as lowercase hex.
 */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Parse an IPv4 address into its four octets, or null if invalid.
 */
function parseIPv4(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

/**
 * Expand an IPv6 address into 8 16-bit groups, or null if invalid.
 * Handles `::` compression and embedded IPv4 (e.g. ::ffff:127.0.0.1).
 */
function parseIPv6(address: string): number[] | null {
  let addr = address;
  const zoneIndex = addr.indexOf('%');
  if (zoneIndex !== -1) addr = addr.slice(0, zoneIndex);

  // Handle embedded IPv4 tail.
  let ipv4Tail: number[] | null = null;
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = addr.slice(lastColon + 1);
    if (tail.includes('.')) {
      const v4 = parseIPv4(tail);
      if (!v4) return null;
      ipv4Tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
      addr = addr.slice(0, lastColon + 1) + '0:0';
      // Recompute: replace the tail with two placeholder groups then fix below.
      addr = address.slice(0, lastColon + 1);
      if (addr.endsWith('::')) {
        addr = addr + '0';
      } else {
        addr = addr + '0';
      }
    }
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const groups: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  let groups: number[];
  if (halves.length === 2) {
    const head = parseGroups(halves[0]);
    const tail = parseGroups(halves[1]);
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail];
  } else {
    const all = parseGroups(halves[0]);
    if (!all) return null;
    groups = all;
  }

  if (groups.length !== 8) return null;

  if (ipv4Tail) {
    groups[6] = ipv4Tail[0];
    groups[7] = ipv4Tail[1];
  }

  return groups;
}

/**
 * Determine whether an IP address is in a private, loopback, link-local,
 * or otherwise non-public range that must be refused for SSRF protection.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const v4 = parseIPv4(address);
    if (!v4) return true; // Fail closed on unparseable input.
    const [a, b] = v4;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 192.0.0.0/24 (IETF protocol assignments)
    if (a === 192 && b === 0 && v4[2] === 0) return true;
    // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 0 && v4[2] === 2) return true;
    // 198.18.0.0/15 (benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && v4[2] === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && v4[2] === 113) return true;
    // 224.0.0.0/4 (multicast)
    if (a >= 224 && a <= 239) return true;
    // 240.0.0.0/4 (reserved) and 255.255.255.255
    if (a >= 240) return true;
    return false;
  }

  if (family === 6) {
    const groups = parseIPv6(address);
    if (!groups) return true; // Fail closed.
    // ::1 loopback
    if (groups.every((g, i) => (i === 7 ? g === 1 : g === 0))) return true;
    // :: unspecified
    if (groups.every((g) => g === 0)) return true;
    // IPv4-mapped ::ffff:0:0/96
    if (
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0xffff
    ) {
      const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
      return isPrivateAddress(v4);
    }
    // IPv4-compatible ::/96 (deprecated) — treat embedded v4 conservatively.
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
      const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
      if (groups[6] !== 0 || groups[7] !== 0) {
        return isPrivateAddress(v4);
      }
    }
    // fc00::/7 (unique local)
    if ((groups[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 (link-local)
    if ((groups[0] & 0xffc0) === 0xfe80) return true;
    // fec0::/10 (deprecated site-local)
    if ((groups[0] & 0xffc0) === 0xfec0) return true;
    // ff00::/8 (multicast)
    if ((groups[0] & 0xff00) === 0xff00) return true;
    return false;
  }

  // Not a valid IP literal — fail closed.
  return true;
}

interface ResolvedTarget {
  address: string;
  family: number;
}

/**
 * Resolve a URL's hostname exactly once and validate the resolved address.
 * Returns the resolved target or throws if the URL is unsafe.
 */
export async function resolveSafeTarget(
  url: URL,
  resolveHost: (hostname: string) => Promise<{ address: string; family: number }>,
): Promise<ResolvedTarget> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new Error('URL has no hostname');
  }

  // If the hostname is already an IP literal, validate directly.
  const literalFamily = isIP(hostname.replace(/^\[|\]$/g, ''));
  let resolved: ResolvedTarget;
  if (literalFamily !== 0) {
    const bare = hostname.replace(/^\[|\]$/g, '');
    resolved = { address: bare, family: literalFamily };
  } else {
    const result = await resolveHost(hostname);
    resolved = { address: result.address, family: result.family };
  }

  if (isPrivateAddress(resolved.address)) {
    throw new Error(`Refusing to connect to private address: ${resolved.address}`);
  }

  return resolved;
}

interface SendOptions {
  url: URL;
  target: ResolvedTarget;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

interface SendResult {
  statusCode: number;
}

/**
 * Send an HTTP(S) request to a pre-resolved IP address, setting the Host
 * header to the original hostname to prevent DNS rebinding.
 */
function sendRequest(options: SendOptions): Promise<SendResult> {
  const { url, target, body, headers, timeoutMs } = options;
  const isHttps = url.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;

  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname;

  return new Promise<SendResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = requestFn(
      {
        protocol: url.protocol,
        host: target.address,
        family: target.family,
        port,
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        headers: {
          ...headers,
          Host: hostHeader,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        // For HTTPS, the SNI/servername must match the original hostname.
        ...(isHttps ? { servername: url.hostname } : {}),
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        // Drain the response body.
        res.resume();
        res.on('end', () => finish(() => resolve({ statusCode })));
        res.on('error', (err) => finish(() => reject(err)));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => finish(() => reject(err)));

    req.write(body);
    req.end();
  });
}

function normalizeTopics(topics: unknown): string[] {
  if (Array.isArray(topics)) {
    return topics.map((t) => String(t));
  }
  if (typeof topics === 'string') {
    // Support Postgres array literal or comma-separated string.
    const trimmed = topics.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed
        .slice(1, -1)
        .split(',')
        .map((t) => t.trim().replace(/^"|"$/g, ''))
        .filter((t) => t.length > 0);
    }
    return trimmed
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
}

function subscriptionMatches(
  sub: WebhookSubscription,
  row: OutboxRow,
): boolean {
  const topics = normalizeTopics(sub.topics);
  if (topics.length > 0 && !topics.includes(row.topic)) {
    return false;
  }
  if (sub.owner_filter && sub.owner_filter !== (row.owner ?? null)) {
    return false;
  }
  return true;
}

function serializePayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload ?? null);
}

export function createWebhookSink(
  pool: Pool,
  options: WebhookSinkOptions = {},
): WebhookSink {
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? randomUUID;
  const resolveHost =
    options.resolveHost ??
    (async (hostname: string) => {
      const result = await lookup(hostname);
      return { address: result.address, family: result.family };
    });

  async function loadSubscriptions(client: PoolClient): Promise<WebhookSubscription[]> {
    const { rows } = await client.query(
      `SELECT id, url, topics, owner_filter, secret, active, consecutive_failures
         FROM webhook_subscriptions
        WHERE active = true`,
    );
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      topics: normalizeTopics(r.topics),
      owner_filter: r.owner_filter ?? null,
      secret: r.secret,
      active: r.active,
      consecutive_failures: Number(r.consecutive_failures ?? 0),
    }));
  }

  async function recordDelivery(
    client: PoolClient,
    params: {
      subscriptionId: string | number;
      eventId: string;
      outboxId: string | number;
      topic: string;
      statusCode: number | null;
      ok: boolean;
      error: string | null;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO webhook_deliveries
         (subscription_id, event_id, outbox_id, topic, status_code, success, error, attempted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        params.subscriptionId,
        params.eventId,
        params.outboxId,
        params.topic,
        params.statusCode,
        params.ok,
        params.error,
      ],
    );
  }

  async function updateFailureState(
    client: PoolClient,
    subscriptionId: string | number,
    ok: boolean,
  ): Promise<void> {
    if (ok) {
      await client.query(
        `UPDATE webhook_subscriptions
            SET consecutive_failures = 0,
                last_success_at = now()
          WHERE id = $1`,
        [subscriptionId],
      );
    } else {
      await client.query(
        `UPDATE webhook_subscriptions
            SET consecutive_failures = consecutive_failures + 1,
                last_failure_at = now(),
                active = CASE
                  WHEN consecutive_failures + 1 >= $2 THEN false
                  ELSE active
                END
          WHERE id = $1`,
        [subscriptionId, failureThreshold],
      );
    }
  }

  async function deliverOne(
    client: PoolClient,
    row: OutboxRow,
    sub: WebhookSubscription,
  ): Promise<DeliveryResult> {
    const eventId = generateId();
    const timestamp = String(Math.floor(now() / 1000));
    const body = serializePayload(row.payload);
    const signature = signPayload(sub.secret, timestamp, body);

    let statusCode: number | null = null;
    let ok = false;
    let error: string | null = null;

    try {
      const url = new URL(sub.url);
      const target = await resolveSafeTarget(url, resolveHost);

      const result = await sendRequest({
        url,
        target,
        body,
        timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'realtime-webhooks/1.0',
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Id': eventId,
          'X-Webhook-Topic': row.topic,
        },
      });

      statusCode = result.statusCode;
      ok = statusCode >= 200 && statusCode < 300;
      if (!ok) {
        error = `Non-2xx response: ${statusCode}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      ok = false;
    }

    await recordDelivery(client, {
      subscriptionId: sub.id,
      eventId,
      outboxId: row.id,
      topic: row.topic,
      statusCode,
      ok,
      error,
    });

    await updateFailureState(client, sub.id, ok);

    return {
      subscriptionId: sub.id,
      eventId,
      ok,
      statusCode: statusCode ?? undefined,
      error: error ?? undefined,
    };
  }

  async function deliver(row: OutboxRow): Promise<DeliveryResult[]> {
    const client = await pool.connect();
    try {
      const subscriptions = await loadSubscriptions(client);
      const matching = subscriptions.filter((sub) => subscriptionMatches(sub, row));
      const results: DeliveryResult[] = [];
      for (const sub of matching) {
        results.push(await deliverOne(client, row, sub));
      }
      return results;
    } finally {
      client.release();
    }
  }

  async function deliverBatch(rows: OutboxRow[]): Promise<DeliveryResult[]> {
    const all: DeliveryResult[] = [];
    for (const row of rows) {
      all.push(...(await deliver(row)));
    }
    return all;
  }

  return { deliver, deliverBatch };
}