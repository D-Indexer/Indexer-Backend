import { Address, Keypair, StrKey, xdr } from '@stellar/stellar-sdk';

/**
 * Contract storage TTL tracking.
 *
 * Soroban persistent storage entries have a TTL (`live_until_ledger`) and are
 * archived once the network ledger passes it. Events do not announce archival,
 * so we periodically query `getLedgerEntries` for the storage keys backing each
 * entity and record the resulting `live_until_ledger`.
 *
 * This module is intentionally free of any database or RPC client dependency so
 * that ledger-key construction and batching can be unit tested in isolation.
 * The caller supplies a `fetchLedgerEntries` function (typically wrapping the
 * RPC client in `src/indexer/rpc.ts`) and a persistence callback.
 */

/** Entity kinds whose storage keys we track. */
export type EntityKind = 'folder' | 'template' | 'portfolio';

/** A single entity whose storage TTL we want to track. */
export interface TrackedEntity {
  kind: EntityKind;
  /** Stable identifier of the entity (e.g. folder id, template id, portfolio id). */
  id: string;
  /** Ledger at which the entity was last active; used for prioritisation. */
  lastActiveLedger?: number;
}

/** Archival status surfaced in API responses. */
export interface ArchivalStatus {
  /** Ledger at which the entry expires, or `null` if unknown / not found. */
  liveUntilLedger: number | null;
  /** Whether the entry is archived (expired) as of the observed ledger. */
  archived: boolean;
}

/** Result of a TTL refresh for a single entity. */
export interface TtlResult extends ArchivalStatus {
  kind: EntityKind;
  id: string;
  /** The base64-encoded ledger key that was queried. */
  ledgerKey: string;
}

/** A soon-to-expire entry, for the status CLI. */
export interface ExpiringEntry {
  kind: EntityKind;
  id: string;
  liveUntilLedger: number;
  /** Number of ledgers remaining until expiry (may be negative if archived). */
  ledgersRemaining: number;
  archived: boolean;
}

/** Configuration bounding RPC usage. */
export interface TtlConfig {
  /** Maximum number of ledger keys per `getLedgerEntries` call. */
  batchSize: number;
  /** Maximum number of `getLedgerEntries` calls per refresh run. */
  maxBatches: number;
  /** Minimum delay (ms) between successive `getLedgerEntries` calls. */
  minDelayMs: number;
  /** Entries expiring within this many ledgers are reported as soon-to-expire. */
  soonToExpireWindow: number;
}

export const DEFAULT_TTL_CONFIG: TtlConfig = {
  batchSize: 50,
  maxBatches: 20,
  minDelayMs: 250,
  soonToExpireWindow: 10_000,
};

/**
 * Storage key layout of the contract.
 *
 * The contract stores entries under a `DataKey` enum. Each variant maps to a
 * distinct ledger key. Keep this in sync with the contract's `DataKey` enum.
 * The discriminant order MUST match the contract definition.
 */
export const DATA_KEY_VARIANTS = {
  folder: 0,
  template: 1,
  portfolio: 2,
} as const;

/** A function that fetches ledger entries for the given base64 keys. */
export type FetchLedgerEntries = (
  keys: string[],
) => Promise<Map<string, { liveUntilLedger: number | null }>>;

/** Persistence callback invoked for each refreshed entity. */
export type PersistTtl = (result: TtlResult) => Promise<void> | void;

/**
 * Build the XDR ledger key for an entity's persistent storage entry.
 *
 * Layout: `ScVal::Vec([ ScVal::U32(variant), ScVal::String(id) ])` wrapped in
 * a `LedgerKey::ContractData` with `Durability::Persistent`.
 *
 * @param contractId StrKey-encoded contract id (`C...`).
 * @param kind Entity kind.
 * @param id Entity identifier.
 * @returns Base64-encoded `LedgerKey`.
 */
export function buildLedgerKey(
  contractId: string,
  kind: EntityKind,
  id: string,
): string {
  if (!StrKey.isValidContract(contractId)) {
    throw new Error(`Invalid contract id: ${contractId}`);
  }
  if (!id) {
    throw new Error('Entity id must be non-empty');
  }

  const variant = DATA_KEY_VARIANTS[kind];
  if (variant === undefined) {
    throw new Error(`Unknown entity kind: ${kind as string}`);
  }

  const dataKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvU32(variant),
    xdr.ScVal.scvString(Buffer.from(id, 'utf8')),
  ]);

  const contractData = new xdr.ContractDataEntry({
    contract: Address.fromString(contractId).toScAddress(),
    key: dataKey,
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvVoid(),
  });

  const ledgerKey = xdr.LedgerKey.contractData(contractData);
  return ledgerKey.toXDR('base64');
}

/**
 * Build ledger keys for a list of entities, preserving order.
 */
export function buildLedgerKeys(
  contractId: string,
  entities: TrackedEntity[],
): Array<{ entity: TrackedEntity; ledgerKey: string }> {
  return entities.map((entity) => ({
    entity,
    ledgerKey: buildLedgerKey(contractId, entity.kind, entity.id),
  }));
}

/**
 * Prioritise entities for refresh: most recently active first, then by kind
 * (folders and templates before portfolios), then by id for determinism.
 */
export function prioritiseEntities(entities: TrackedEntity[]): TrackedEntity[] {
  const kindRank: Record<EntityKind, number> = {
    folder: 0,
    template: 1,
    portfolio: 2,
  };
  return [...entities].sort((a, b) => {
    const aActive = a.lastActiveLedger ?? -1;
    const bActive = b.lastActiveLedger ?? -1;
    if (aActive !== bActive) return bActive - aActive;
    const kindDiff = kindRank[a.kind] - kindRank[b.kind];
    if (kindDiff !== 0) return kindDiff;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Split items into batches of at most `batchSize`.
 */
export function chunk<T>(items: T[], batchSize: number): T[][] {
  if (batchSize <= 0) {
    throw new Error('batchSize must be positive');
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Compute archival status from a `live_until_ledger` and the current ledger.
 *
 * An entry is archived when the current ledger is greater than or equal to its
 * `live_until_ledger` (the entry is live while `ledger < live_until_ledger`).
 * A missing entry (`liveUntilLedger === null`) is treated as archived because
 * the contract cannot use it.
 */
export function computeArchivalStatus(
  liveUntilLedger: number | null,
  currentLedger: number,
): ArchivalStatus {
  if (liveUntilLedger === null) {
    return { liveUntilLedger: null, archived: true };
  }
  return {
    liveUntilLedger,
    archived: currentLedger >= liveUntilLedger,
  };
}

/**
 * Filter results down to entries that are archived or expiring soon.
 */
export function findExpiringEntries(
  results: TtlResult[],
  currentLedger: number,
  window: number = DEFAULT_TTL_CONFIG.soonToExpireWindow,
): ExpiringEntry[] {
  const expiring: ExpiringEntry[] = [];
  for (const result of results) {
    if (result.liveUntilLedger === null) {
      expiring.push({
        kind: result.kind,
        id: result.id,
        liveUntilLedger: 0,
        ledgersRemaining: 0,
        archived: true,
      });
      continue;
    }
    const ledgersRemaining = result.liveUntilLedger - currentLedger;
    if (ledgersRemaining <= window) {
      expiring.push({
        kind: result.kind,
        id: result.id,
        liveUntilLedger: result.liveUntilLedger,
        ledgersRemaining,
        archived: ledgersRemaining <= 0,
      });
    }
  }
  return expiring.sort((a, b) => a.ledgersRemaining - b.ledgersRemaining);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RefreshTtlOptions {
  contractId: string;
  entities: TrackedEntity[];
  currentLedger: number;
  fetchLedgerEntries: FetchLedgerEntries;
  persist?: PersistTtl;
  config?: Partial<TtlConfig>;
  /** Injectable sleep for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface RefreshTtlSummary {
  results: TtlResult[];
  /** Number of `getLedgerEntries` calls actually made. */
  batchesFetched: number;
  /** Number of entities skipped because the batch limit was reached. */
  skipped: number;
}

/**
 * Refresh TTLs for the given entities, respecting batch size and rate limits.
 *
 * Entities are prioritised (recently active first) and processed in batches of
 * at most `config.batchSize`. At most `config.maxBatches` RPC calls are made per
 * run; remaining entities are skipped and reported in the summary.
 */
export async function refreshTtls(
  options: RefreshTtlOptions,
): Promise<RefreshTtlSummary> {
  const config: TtlConfig = { ...DEFAULT_TTL_CONFIG, ...options.config };
  const sleepFn = options.sleepFn ?? sleep;

  const prioritised = prioritiseEntities(options.entities);
  const batches = chunk(prioritised, config.batchSize);

  const results: TtlResult[] = [];
  let batchesFetched = 0;
  let skipped = 0;

  for (let i = 0; i < batches.length; i++) {
    if (batchesFetched >= config.maxBatches) {
      skipped += batches.slice(i).reduce((sum, b) => sum + b.length, 0);
      break;
    }

    if (batchesFetched > 0) {
      await sleepFn(config.minDelayMs);
    }

    const batch = batches[i];
    const keyed = buildLedgerKeys(options.contractId, batch);
    const keys = keyed.map((k) => k.ledgerKey);

    const fetched = await options.fetchLedgerEntries(keys);
    batchesFetched++;

    for (const { entity, ledgerKey } of keyed) {
      const entry = fetched.get(ledgerKey);
      const liveUntilLedger = entry ? entry.liveUntilLedger : null;
      const status = computeArchivalStatus(liveUntilLedger, options.currentLedger);
      const result: TtlResult = {
        kind: entity.kind,
        id: entity.id,
        ledgerKey,
        liveUntilLedger: status.liveUntilLedger,
        archived: status.archived,
      };
      results.push(result);
      if (options.persist) {
        await options.persist(result);
      }
    }
  }

  return { results, batchesFetched, skipped };
}

/**
 * Convenience helper: derive an archival status object suitable for API
 * responses from a stored `live_until_ledger`.
 */
export function toArchivalStatus(
  liveUntilLedger: number | null,
  currentLedger: number,
): ArchivalStatus {
  return computeArchivalStatus(liveUntilLedger, currentLedger);
}

// Re-export for callers that need to validate contract ids.
export { Keypair };
```

Unit tests (place in `src/indexer/ttl.test.ts`):

```typescript
import { describe, expect, it, vi } from 'vitest';
import {
  buildLedgerKey,
  buildLedgerKeys,
  chunk,
  computeArchivalStatus,
  findExpiringEntries,
  prioritiseEntities,
  refreshTtls,
  DEFAULT_TTL_CONFIG,
  type TrackedEntity,
} from './ttl';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

describe('buildLedgerKey', () => {
  it('produces a stable base64 ledger key for a folder', () => {
    const key = buildLedgerKey(CONTRACT_ID, 'folder', 'folder-1');
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
    // Deterministic.
    expect(buildLedgerKey(CONTRACT_ID, 'folder', 'folder-1')).toBe(key);
  });

  it('produces distinct keys per kind and id', () => {
    const a = buildLedgerKey(CONTRACT_ID, 'folder', 'x');
    const b = buildLedgerKey(CONTRACT_ID, 'template', 'x');
    const c = buildLedgerKey(CONTRACT_ID, 'folder', 'y');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('rejects invalid contract ids and empty ids', () => {
    expect(() => buildLedgerKey('not-a-contract', 'folder', 'x')).toThrow();
    expect(() => buildLedgerKey(CONTRACT_ID, 'folder', '')).toThrow();
  });
});

describe('buildLedgerKeys', () => {
  it('preserves order', () => {
    const entities: TrackedEntity[] = [
      { kind: 'folder', id: 'a' },
      { kind: 'portfolio', id: 'b' },
    ];
    const keyed = buildLedgerKeys(CONTRACT_ID, entities);
    expect(keyed.map((k) => k.entity.id)).toEqual(['a', 'b']);
  });
});

describe('chunk', () => {
  it('splits into batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('rejects non-positive batch size', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('prioritiseEntities', () => {
  it('orders by last active ledger descending', () => {
    const sorted = prioritiseEntities([
      { kind: 'portfolio', id: 'p', lastActiveLedger: 5 },
      { kind: 'folder', id: 'f', lastActiveLedger: 10 },
      { kind: 'template', id: 't', lastActiveLedger: 7 },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['f', 't', 'p']);
  });
});

describe('computeArchivalStatus', () => {
  it('marks archived when current >= liveUntil', () => {
    expect(computeArchivalStatus(100, 100).archived).toBe(true);
    expect(computeArchivalStatus(100, 101).archived).toBe(true);
    expect(computeArchivalStatus(100, 99).archived).toBe(false);
  });
  it('treats missing entries as archived', () => {
    expect(computeArchivalStatus(null, 1)).toEqual({
      liveUntilLedger: null,
      archived: true,
    });
  });
});

describe('findExpiringEntries', () => {
  it('includes archived and soon-to-expire entries', () => {
    const results = [
      { kind: 'folder' as const, id: 'a', ledgerKey: 'k', liveUntilLedger: 105, archived: false },
      { kind: 'folder' as const, id: 'b', ledgerKey: 'k', liveUntilLedger: 1000, archived: false },
      { kind: 'folder' as const, id: 'c', ledgerKey: 'k', liveUntilLedger: 90, archived: true },
    ];
    const expiring = findExpiringEntries(results, 100, 10);
    expect(expiring.map((e) => e.id)).toEqual(['c', 'a']);
  });
});

describe('refreshTtls', () => {
  it('respects batch size and max batches', async () => {
    const entities: TrackedEntity[] = Array.from({ length: 5 }, (_, i) => ({
      kind: 'folder',
      id: `f${i}`,
      lastActiveLedger: i,
    }));
    const fetchLedgerEntries = vi.fn(async (keys: string[]) => {
      const map = new Map<string, { liveUntilLedger: number | null }>();
      for (const k of keys) map.set(k, { liveUntilLedger: 200 });
      return map;
    });

    const summary = await refreshTtls({
      contractId: CONTRACT_ID,
      entities,
      currentLedger: 100,
      fetchLedgerEntries,
      config: { batchSize: 2, maxBatches: 2, minDelayMs: 0 },
      sleepFn: async () => {},
    });

    expect(summary.batchesFetched).toBe(2);
    expect(summary.results).toHaveLength(4);
    expect(summary.skipped).toBe(1);
    expect(fetchLedgerEntries).toHaveBeenCalledTimes(2);
    expect(fetchLedgerEntries.mock.calls[0][0]).toHaveLength(2);
  });

  it('persists results and computes archival status', async () => {
    const persist = vi.fn();
    const fetchLedgerEntries = async (keys: string[]) => {
      const map = new Map<string, { liveUntilLedger: number | null }>();
      for (const k of keys) map.set(k, { liveUntilLedger: 50 });
      return map;
    };
    const summary = await refreshTtls({
      contractId: CONTRACT_ID,
      entities: [{ kind: 'folder', id: 'f' }],
      currentLedger: 100,
      fetchLedgerEntries,
      persist,
      config: { ...DEFAULT_TTL_CONFIG, minDelayMs: 0 },
      sleepFn: async () => {},
    });
    expect(summary.results[0].archived).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});