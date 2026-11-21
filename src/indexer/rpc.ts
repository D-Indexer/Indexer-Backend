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
  contractId: string;
  limit: number;
} & ({ startLedger: number; cursor?: never } | { cursor: string; startLedger?: never });

export type HealthResult = {
  status: string;
  latestLedger: number;
  oldestLedger: number;
  ledgerRetentionWindow?: number;
};

/**
 * Runtime schemas for RPC responses. The RPC is an untrusted boundary: a
 * malformed body must fail loudly (and retryably) instead of reaching the
 * indexer as `undefined` fields.
 */
export const rawEventSchema = z.object({
  type: z.string(),
  ledger: z.number().int().nonnegative(),
  ledgerClosedAt: z.string(),
  contractId: z.string(),
  id: z.string().min(1),
  txHash: z.string(),
  topic: z.array(z.string()),
  value: z.string(),
});

export const getEventsResultSchema = z.object({
  events: z.array(rawEventSchema),
  cursor: z.string().min(1),
  latestLedger: z.number().int().nonnegative(),
  oldestLedger: z.number().int().nonnegative(),
});

export const healthResultSchema = z.object({
  status: z.string(),
  latestLedger: z.number().int().nonnegative(),
  oldestLedger: z.number().int().nonnegative(),
  ledgerRetentionWindow: z.number().int().nonnegative().optional(),
});

/** Format a zod issue as `path: message` for error messages. */
function describeIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `${path}: ${issue.message}`;
}

/**
 * Parse `value` with `schema`, throwing a retryable `RpcError` that names the
 * offending field path when the response is malformed.
 */
export function parseRpcResult<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(describeIssue).join('; ');
    throw new RpcError(`${method}: malformed response (${detail})`, undefined, true);
  }
  return parsed.data;
}

/**
 * Enforce the invariants the indexer relies on for a `getEvents` page: every
 * event is a contract event for the requested contract, ids strictly increase
 * (so the cursor can never move backwards), and a cursor is always present.
 */
export function assertGetEventsInvariants(
  result: GetEventsResult,
  contractId: string
): GetEventsResult {
  if (result.cursor.length === 0) {
    throw new RpcError('getEvents: malformed response (cursor: missing)', undefined, true);
  }
  let previous: string | undefined;
  result.events.forEach((event, index) => {
    if (event.type !== 'contract') {
      throw new RpcError(
        `getEvents: malformed response (events.${index}.type: expected 'contract', got '${event.type}')`,
        undefined,
        true
      );
    }
    if (event.contractId !== contractId) {
      throw new RpcError(
        `getEvents: malformed response (events.${index}.contractId: expected '${contractId}', got '${event.contractId}')`,
        undefined,
        true
      );
    }
    if (previous !== undefined && !(event.id > previous)) {
      throw new RpcError(
        `getEvents: malformed response (events.${index}.id: '${event.id}' is not greater than '${previous}')`,
        undefined,
        true
      );
    }
    previous = event.id;
  });
  return result;
}

/** Result of `getLedgerEntries` for the contract instance entry. */
export type ContractInstanceResult = {
  /** Hex-encoded WASM hash the contract instance currently points at, or null when absent. */
  wasmHash: string | null;
  /** Ledger the instance entry was last modified in, or null when absent. */
  lastModifiedLedger: number | null;
};

export interface EventSource {
  getEvents(params: GetEventsParams): Promise<GetEventsResult>;
  getHealth(): Promise<HealthResult>;
  /** Read the contract instance entry to detect WASM upgrades. */
  getContractInstance(contractId: string): Promise<ContractInstanceResult>;
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

    let raw = '';
    let body: {
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
      return call<unknown>('getEvents', {
        ...(params.startLedger !== undefined ? { startLedger: params.startLedger } : {}),
        filters: [{ type: 'contract', contractIds: [params.contractId] }],
        pagination,
      }).then((result) =>
        assertGetEventsInvariants(
          parseRpcResult('getEvents', getEventsResultSchema, result),
          params.contractId
        )
      );
    },
    getHealth() {
      return call<unknown>('getHealth').then((result) =>
        parseRpcResult('getHealth', healthResultSchema, result)
      );
    },
    async getContractInstance(contractId) {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: Address.fromString(contractId).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        })
      );
      const result = await call<{
        entries?: {
          lastModifiedLedgerSeq?: number;
          val?: { contractData?: () => { val: () => xdr.ScVal } };
        }[];
      }>('getLedgerEntries', { keys: [key.toXDR('base64')] });

      const entry = result.entries?.[0];
      const instance = entry?.val?.contractData?.().val();
      if (!instance || instance.switch().name !== 'scvContractInstance') {
        return { wasmHash: null, lastModifiedLedger: null };
      }
      return {
        wasmHash: instance.instance().executable().wasmHash().toString('hex'),
        lastModifiedLedger: entry?.lastModifiedLedgerSeq ?? null,
      };
    },
  };
}
