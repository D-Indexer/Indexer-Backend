/**
 * Minimal Soroban RPC JSON-RPC client for the two methods the indexer needs.
 *
 * We call the RPC directly instead of `SorobanRpc.Server#getEvents` because the
 * SDK's parsed response replaces `contractId` and `topic` with objects, and we
 * want the raw base64 XDR to store alongside each event.
 */

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
  getEvents(params: GetEventsParams, signal?: AbortSignal): Promise<GetEventsResult>;
  getHealth(signal?: AbortSignal): Promise<HealthResult>;
}

/** Thrown when a call is cancelled through its AbortSignal (e.g. indexer shutdown). */
export class RpcAbortError extends Error {
  constructor(message = 'RPC call aborted') {
    super(message);
    this.name = 'RpcAbortError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof RpcAbortError || (err as { name?: unknown })?.name === 'AbortError';
}

/** Reject as soon as `signal` aborts, so retry sleeps and fetches stop promptly. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new RpcAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RpcAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
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
  let nextId = 1;

  async function callOnce<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new RpcAbortError();
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
          : AbortSignal.timeout(options.timeoutMs),
      });
    } catch (err) {
      if (signal?.aborted) throw new RpcAbortError();
      const reason = err instanceof Error ? err.name : 'unknown';
      throw new RpcError(`${method} to ${safeUrl} failed: ${reason}`, undefined, true);
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new RpcError(`${method} to ${safeUrl} returned HTTP ${response.status}`, undefined, retryable);
    }

    const body = (await abortable(response.json(), signal)) as {
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

  async function call<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callOnce<T>(method, params, signal);
      } catch (err) {
        if (signal?.aborted) throw new RpcAbortError();
        if (!(err instanceof RpcError) || !err.retryable || attempt >= maxAttempts) throw err;
        const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
        await abortable(sleep(delay), signal);
      }
    }
  }

  return {
    getEvents(params, signal) {
      const pagination =
        params.cursor !== undefined
          ? { cursor: params.cursor, limit: params.limit }
          : { limit: params.limit };
      return call<GetEventsResult>(
        'getEvents',
        {
          ...(params.startLedger !== undefined ? { startLedger: params.startLedger } : {}),
          filters: [{ type: 'contract', contractIds: [params.contractId] }],
          pagination,
        },
        signal
      );
    },
    getHealth(signal) {
      return call<HealthResult>('getHealth', undefined, signal);
    },
  };
}
