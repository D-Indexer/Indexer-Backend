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

/** Result of the RPC `getVersionInfo` method. */
export type VersionInfo = {
  version: string;
  commitHash?: string;
  buildTimestamp?: string;
  captiveCoreVersion?: string;
  protocolVersion?: number;
};

export interface EventSource {
  getEvents(params: GetEventsParams): Promise<GetEventsResult>;
  getHealth(): Promise<HealthResult>;
  getVersionInfo?(): Promise<VersionInfo>;
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

/**
 * Soroban RPC versions whose `getEvents` shape this client is tested against.
 * See docs/architecture.md#soroban-rpc-compatibility.
 */
export const SUPPORTED_RPC_VERSION_RANGE = { min: '21.0.0', max: '23.99.99' } as const;

export type RpcVersionPolicy = 'warn' | 'refuse';

export type RpcVersionCheck = {
  version: string;
  supported: boolean;
  policy: RpcVersionPolicy;
};

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** True when `version` falls inside `SUPPORTED_RPC_VERSION_RANGE` (inclusive). */
export function isSupportedRpcVersion(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return (
    compareVersions(parsed, parseVersion(SUPPORTED_RPC_VERSION_RANGE.min)!) >= 0 &&
    compareVersions(parsed, parseVersion(SUPPORTED_RPC_VERSION_RANGE.max)!) <= 0
  );
}

/**
 * Read the RPC version and decide whether it is supported. With policy `refuse`
 * an unsupported (or unreadable) version throws; with `warn` it only reports.
 */
export async function checkRpcVersion(
  rpc: Pick<EventSource, 'getVersionInfo'>,
  policy: RpcVersionPolicy
): Promise<RpcVersionCheck> {
  let version: string;
  try {
    if (!rpc.getVersionInfo) throw new Error('getVersionInfo is not available');
    version = (await rpc.getVersionInfo()).version;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (policy === 'refuse') {
      throw new RpcError(`Could not read the Soroban RPC version: ${reason}`, undefined, false);
    }
    return { version: 'unknown', supported: false, policy };
  }

  const supported = isSupportedRpcVersion(version);
  if (!supported && policy === 'refuse') {
    throw new RpcError(
      `Soroban RPC version ${version} is outside the supported range ` +
        `${SUPPORTED_RPC_VERSION_RANGE.min} - ${SUPPORTED_RPC_VERSION_RANGE.max}. ` +
        'See docs/architecture.md#soroban-rpc-compatibility.',
      undefined,
      false
    );
  }
  return { version, supported, policy };
}

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

  async function callOnce<T>(method: string, params?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
      // -32600 is "invalid request". The RPC uses it for out-of-range ledgers and
      // cursors, but the message wording has changed between releases, so ask
      // getHealth for the retained window instead of trusting the text.
      if (body.error.code === -32600) {
        const health = await callOnce<HealthResult>('getHealth');
        if (health.oldestLedger !== undefined && health.latestLedger !== undefined) {
          throw new LedgerRangeError(body.error.message, health.oldestLedger, health.latestLedger);
        }
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
    getVersionInfo() {
      return call<VersionInfo>('getVersionInfo');
    },
  };
}
