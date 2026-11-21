/**
 * Minimal Soroban RPC JSON-RPC client for the two methods the indexer needs.
 *
 * We call the RPC directly instead of `SorobanRpc.Server#getEvents` because the
 * SDK's parsed response replaces `contractId` and `topic` with objects, and we
 * want the raw base64 XDR to store alongside each event.
 */

import { logger } from '../utils/logger';

/** Event exactly as returned by the RPC `getEvents` method. */
export type RawEvent = {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  txHash: string;
  topic: string[];
  value: string;
};

export type GetEventsResult = {
  events: RawEvent[];
  cursor: string;
  latestLedger: number;
  oldestLedger: number;
};

export type GetEventsParams = {
  contractId: string;
  limit: number;
} & ({ startLedger: number; cursor?: never } | { cursor: string; startLedger?: never });

export type HealthResult = {
  status: string;
  latestLedger: number;
  oldestLedger: number;
  ledgerRetentionWindow?: number;
};

export interface EventSource {
  getEvents(params: GetEventsParams): Promise<GetEventsResult>;
  getHealth(): Promise<HealthResult>;
  /** Redacted URL of the endpoint currently serving requests, when known. */
  readonly activeEndpoint?: string;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** The requested ledger/cursor is outside the RPC's retained ledger range. */
export class LedgerRangeError extends RpcError {
  constructor(
    message: string,
    readonly oldestLedger: number,
    readonly latestLedger: number
  ) {
    super(message, -32600, false);
    this.name = 'LedgerRangeError';
  }
}

const RANGE_RE = /ledger range:\s*(\d+)\s*-\s*(\d+)/;

export type RpcClientOptions = {
  url: string;
  timeoutMs: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Extra HTTP headers sent with every request (e.g. paid provider API keys). Never logged. */
  headers?: Record<string, string>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Strip credentials and query strings (API keys) from a URL before it appears in logs or errors. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

export function createRpcClient(options: RpcClientOptions): EventSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const safeUrl = redactUrl(options.url);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
  let nextId = 1;

  async function callOnce<T>(method: string, params?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'unknown';
      throw new RpcError(`${method} to ${safeUrl} failed: ${reason}`, undefined, true);
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new RpcError(`${method} to ${safeUrl} returned HTTP ${response.status}`, undefined, retryable);
    }

    const body = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };

    if (body.error) {
      const range = RANGE_RE.exec(body.error.message);
      if (range) {
        throw new LedgerRangeError(body.error.message, Number(range[1]), Number(range[2]));
      }
      // -32603 is the JSON-RPC "internal error" code; treat it as transient.
      throw new RpcError(`${method}: ${body.error.message}`, body.error.code, body.error.code === -32603);
    }
    if (body.result === undefined) {
      throw new RpcError(`${method}: response had no result`, undefined, true);
    }
    return body.result;
  }

  async function call<T>(method: string, params?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callOnce<T>(method, params);
      } catch (err) {
        if (!(err instanceof RpcError) || !err.retryable || attempt >= maxAttempts) throw err;
        const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
        await sleep(delay);
      }
    }
  }

  return {
    get activeEndpoint() {
      return safeUrl;
    },
    getEvents(params) {
      const pagination =
        params.cursor !== undefined
          ? { cursor: params.cursor, limit: params.limit }
          : { limit: params.limit };
      return call<GetEventsResult>('getEvents', {
        ...(params.startLedger !== undefined ? { startLedger: params.startLedger } : {}),
        filters: [{ type: 'contract', contractIds: [params.contractId] }],
        pagination,
      });
    },
    getHealth() {
      return call<HealthResult>('getHealth');
    },
  };
}

export type FailoverOptions = {
  /** Endpoint URLs, primary first. */
  urls: string[];
  timeoutMs: number;
  /** Consecutive failures before an endpoint is skipped for the cool-down. */
  failureThreshold?: number;
  /** How long a failed endpoint is skipped before it is retried. */
  cooldownMs?: number;
  /** Ledger the indexer has already scanned; endpoints behind it are skipped. */
  cursorLedger?: () => number | undefined;
  now?: () => number;
  /** Extra HTTP headers sent with every request to every endpoint. Never logged. */
  headers?: Record<string, string>;
  createClient?: (url: string) => EventSource;
};

type EndpointState = {
  url: string;
  client: EventSource;
  failures: number;
  /** Timestamp until which the endpoint is skipped after hitting the threshold. */
  cooldownUntil: number;
  /** Latest ledger reported by the endpoint's last health check, if any. */
  latestLedger?: number;
};

/**
 * EventSource that spreads requests over several RPC endpoints.
 *
 * An endpoint is skipped after `failureThreshold` consecutive failures until
 * `cooldownMs` elapses, and endpoints whose `latestLedger` is behind the saved
 * cursor are skipped so a lagging replica cannot stall indexing.
 */
export function createFailoverEventSource(options: FailoverOptions): EventSource {
  const threshold = options.failureThreshold ?? 3;
  const cooldownMs = options.cooldownMs ?? 60000;
  const now = options.now ?? Date.now;
  const createClient =
    options.createClient ??
    ((url: string) => createRpcClient({ url, timeoutMs: options.timeoutMs, headers: options.headers }));
  const endpoints: EndpointState[] = options.urls.map((url) => ({
    url,
    client: createClient(url),
    failures: 0,
    cooldownUntil: 0,
  }));
  let active = 0;

  function available(endpoint: EndpointState): boolean {
    if (endpoint.cooldownUntil > now()) return false;
    const cursor = options.cursorLedger?.();
    if (cursor !== undefined && endpoint.latestLedger !== undefined && endpoint.latestLedger < cursor) {
      return false;
    }
    return true;
  }

  /** Endpoints to try, starting at the active one and wrapping around. */
  function candidates(): EndpointState[] {
    const ordered = [...endpoints.slice(active), ...endpoints.slice(0, active)];
    const usable = ordered.filter(available);
    // Everything is cooling down or behind the cursor: try them all rather than stall.
    return usable.length > 0 ? usable : ordered;
  }

  function succeeded(endpoint: EndpointState): void {
    endpoint.failures = 0;
    endpoint.cooldownUntil = 0;
    active = endpoints.indexOf(endpoint);
  }

  function failed(endpoint: EndpointState): void {
    endpoint.failures++;
    if (endpoint.failures >= threshold) {
      endpoint.cooldownUntil = now() + cooldownMs;
      logger.warn('RPC endpoint failed; cooling down', {
        endpoint: redactUrl(endpoint.url),
        failures: endpoint.failures,
        cooldownMs,
      });
    }
  }

  async function attempt<T>(method: string, run: (client: EventSource) => Promise<T>): Promise<T> {
    const tried = candidates();
    let lastError: unknown;
    for (const endpoint of tried) {
      try {
        const result = await run(endpoint.client);
        succeeded(endpoint);
        return result;
      } catch (err) {
        lastError = err;
        // A ledger-range error is a valid answer from a healthy endpoint.
        if (err instanceof LedgerRangeError) {
          succeeded(endpoint);
          throw err;
        }
        failed(endpoint);
        logger.warn('RPC endpoint request failed', {
          method,
          endpoint: redactUrl(endpoint.url),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw lastError;
  }

  return {
    get activeEndpoint() {
      return redactUrl(endpoints[active].url);
    },
    getEvents(params) {
      return attempt('getEvents', (client) => client.getEvents(params));
    },
    async getHealth() {
      const health = await attempt('getHealth', (client) => client.getHealth());
      const endpoint = endpoints[active];
      if (endpoint) endpoint.latestLedger = health.latestLedger;
      return health;
    },
  };
}