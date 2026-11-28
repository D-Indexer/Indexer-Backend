import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A single recorded timing entry for a named dependency (e.g. `db`, `ipfs`).
 */
export interface TimingEntry {
  /** Number of operations recorded under this name. */
  count: number;
  /** Total accumulated duration in milliseconds. */
  durationMs: number;
}

/**
 * Mutable accumulator of dependency timings for the current request/page.
 */
export type Timings = Record<string, TimingEntry>;

/**
 * Context propagated through async calls via AsyncLocalStorage.
 *
 * - API requests carry a `requestId`.
 * - Indexer page processing carries a `pageId` and `cursor`.
 *
 * The `timings` map is mutable and shared for the lifetime of the context so
 * that instrumentation deep in the call stack can record durations without
 * threading state through every function signature.
 */
export interface RequestContext {
  /** Request id for API requests. */
  requestId?: string;
  /** Page id for indexer page processing. */
  pageId?: string;
  /** Cursor for indexer page processing. */
  cursor?: string;
  /** Accumulated dependency timings. */
  timings: Timings;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with a fresh context derived from `seed`.
 *
 * The provided `timings` (if any) are copied into a new mutable map so that
 * concurrent contexts never share state.
 */
export function runWithContext<T>(
  seed: Omit<RequestContext, 'timings'> & { timings?: Timings },
  fn: () => T,
): T {
  const context: RequestContext = {
    requestId: seed.requestId,
    pageId: seed.pageId,
    cursor: seed.cursor,
    timings: { ...(seed.timings ?? {}) },
  };
  return storage.run(context, fn);
}

/**
 * Returns the current context, or `undefined` when called outside of a
 * `runWithContext` scope.
 */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Returns the current timings map, or `undefined` when outside a context.
 */
export function getTimings(): Timings | undefined {
  return storage.getStore()?.timings;
}

/**
 * Record a timing for a named dependency in the current context.
 *
 * No-op when called outside of a context. Negative or non-finite durations
 * are ignored to keep the accumulator sane.
 */
export function recordTiming(name: string, durationMs: number): void {
  const context = storage.getStore();
  if (!context) {
    return;
  }
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }
  const existing = context.timings[name];
  if (existing) {
    existing.count += 1;
    existing.durationMs += durationMs;
  } else {
    context.timings[name] = { count: 1, durationMs };
  }
}

/**
 * Convenience helper: time an async operation and record it under `name`.
 *
 * The result (or error) of `fn` is propagated unchanged.
 */
export async function withTiming<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordTiming(name, performance.now() - start);
  }
}

/**
 * Convenience helper: time a synchronous operation and record it under `name`.
 */
export function withTimingSync<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    recordTiming(name, performance.now() - start);
  }
}