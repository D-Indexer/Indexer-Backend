/**
 * Minimal Soroban RPC JSON-RPC client for the two methods the indexer needs.
 *
 * We call the RPC directly instead of `SorobanRpc.Server#getEvents` because the
 * SDK's parsed response replaces `contractId` and `topic` with objects, and we
 * want the raw base64 XDR to store alongside each event.
 */

import { Address, xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';
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
  contractId?: string;
  contractIds?: string[];
  limit: number;
} & ({ startLedger: number; cursor?: never } | { cursor: string; startLedger?: never });

export type HealthResult = {
  status: string;
  latestLedger: number;
  oldestLedger: number;
  ledgerRetentionWindow?: number;
};

/** A single ledger entry as returned by the RPC `getLedgerEntries` method. */
export type RawLedgerEntry = {
  /** Base64-encoded `LedgerKey` XDR, echoed back by the RPC. */
  key: string;
  /** Base64-encoded `LedgerEntryData` XDR. */
  xdr: string;
  /** Ledger sequence at which the entry expires (0 for non-TTL entries). */
  liveUntilLedgerSeq?: number;
  lastModifiedLedgerSeq?: number;
  /** Present when the entry has been archived/evicted and only its TTL remains. */
  ext?: unknown;
};

export type GetLedgerEntriesResult = {
  entries: RawLedgerEntry[];
  latestLedger: number;
};

export type GetLedgerEntriesParams = {
  /** Base64-encoded `LedgerKey` XDR values to look up. */
  keys: string[];
};

export interface EventSource {
  getEvents(params: GetEventsParams): Promise<GetEventsResult>;
  getHealth(): Promise<HealthResult>;
  getLedgerEntries(params: GetLedgerEntriesParams): Promise<GetLedgerEntriesResult>;
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
    try {
      raw = await response.text();
      body = JSON.parse(raw) as typeof body;
    } catch {
      const contentType = response.headers.get('content-type') ?? 'unknown';
      logger.warn('RPC returned a non-JSON body', {
        method,
        url: safeUrl,
        contentType,
        body: raw.slice(0, 200),
      });
      throw new RpcError(`${method} to ${safeUrl} returned a non-JSON body`, undefined, true);
    }

    if (body === null || typeof body !== 'object') {
      throw new RpcError(`${method} to ${safeUrl} returned a non-JSON body`, undefined, true);
    }

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
      return call<unknown>('getEvents', {
        ...(params.startLedger !== undefined ? { startLedger: params.startLedger } : {}),
        filters: [{
          type: 'contract',
          contractIds: params.contractIds ?? (params.contractId ? [params.contractId] : []),
        }],
        pagination,
      }).then((result) =>
        assertGetEventsInvariants(
          parseRpcResult('getEvents', getEventsResultSchema, result),
          params.contractId
        )
      );
    },
    getLedgerEntries(keys, signal) {
      return call<GetLedgerEntriesResult>('getLedgerEntries', { keys }, signal);
    },
    getLedgerEntries(params) {
      return call<GetLedgerEntriesResult>('getLedgerEntries', { keys: params.keys });
    },
    getVersionInfo() {
      return call<VersionInfo>('getVersionInfo');
    },
  };
}
