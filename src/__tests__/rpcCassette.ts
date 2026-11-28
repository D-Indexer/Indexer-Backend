import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Record-and-replay harness for RPC interactions.
 *
 * Cassettes are JSON files stored under `src/__tests__/cassettes/`. Each cassette
 * captures an ordered list of request/response pairs for a single scenario
 * (e.g. full catch-up, empty pages, retention-gap errors, partial pages at tip).
 *
 * Recording
 * ---------
 * Set `RPC_RECORD=1` and run the indexer tests. Every `RecordingEventSource`
 * created during the run will (re)write its cassette on `close()` (or when the
 * process exits). URLs and API keys are scrubbed before writing so cassettes
 * are safe to commit.
 *
 *   RPC_RECORD=1 npm test -- indexer
 *
 * Replay
 * ------
 * By default (no `RPC_RECORD`), `ReplayEventSource` serves responses strictly
 * from the cassette. Requests are matched by a stable key derived from the
 * scrubbed request payload. Unknown requests throw so tests fail loudly rather
 * than silently falling through to the network.
 *
 * Determinism
 * -----------
 * - Object keys are sorted recursively before serialization.
 * - Request/response pairs are stored in the order they were observed.
 * - URLs are normalized (query params sorted, secrets removed).
 * - The file ends with a trailing newline and uses 2-space indentation.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CassetteEntry {
  /** Stable key derived from the scrubbed request. */
  key: string;
  /** Scrubbed request payload. */
  request: JsonValue;
  /** Scrubbed response payload. */
  response: JsonValue;
}

export interface Cassette {
  /** Cassette name (matches the file basename without extension). */
  name: string;
  /** Ordered request/response pairs. */
  entries: CassetteEntry[];
}

/**
 * Minimal EventSource-like interface used by the indexer. Kept structural so
 * the harness doesn't depend on a specific RPC client implementation.
 */
export interface EventSource {
  getEvents(request: JsonValue): Promise<JsonValue>;
}

const CASSETTE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cassettes');

const SECRET_QUERY_PARAMS = new Set([
  'api_key',
  'apikey',
  'key',
  'token',
  'access_token',
  'auth',
  'authorization',
]);

const SECRET_HEADER_KEYS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
]);

const REDACTED = '[REDACTED]';

/**
 * Recursively sort object keys so serialized output is deterministic.
 */
export function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as { [key: string]: JsonValue })[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Scrub secrets from a URL string. Query params are sorted and secret values
 * are replaced with `[REDACTED]`. The origin/path are preserved.
 */
export function scrubUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL; return as-is (nothing to scrub).
    return raw;
  }
  const params = Array.from(url.searchParams.entries())
    .map(([k, v]): [string, string] => [
      k,
      SECRET_QUERY_PARAMS.has(k.toLowerCase()) ? REDACTED : v,
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of params) {
    url.searchParams.append(k, v);
  }
  return url.toString();
}

/**
 * Scrub secrets from an arbitrary request/response payload. Handles nested
 * objects, arrays, and URL-looking strings. Header-like keys are redacted.
 */
export function scrub(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return scrubUrl(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrub);
  }
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_HEADER_KEYS.has(key.toLowerCase())) {
        out[key] = REDACTED;
      } else if (SECRET_QUERY_PARAMS.has(key.toLowerCase())) {
        out[key] = REDACTED;
      } else {
        out[key] = scrub(child);
      }
    }
    return out;
  }
  return value;
}

/**
 * Derive a stable key from a scrubbed request payload.
 */
export function requestKey(request: JsonValue): string {
  const canonical = JSON.stringify(sortKeys(scrub(request)));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function cassettePath(name: string): string {
  return join(CASSETTE_DIR, `${name}.json`);
}

function ensureCassetteDir(): void {
  if (!existsSync(CASSETTE_DIR)) {
    mkdirSync(CASSETTE_DIR, { recursive: true });
  }
}

function isRecording(): boolean {
  return process.env.RPC_RECORD === '1';
}

/**
 * Serialize a cassette deterministically: sorted keys, stable entry order,
 * 2-space indentation, trailing newline.
 */
export function serializeCassette(cassette: Cassette): string {
  const normalized: Cassette = {
    name: cassette.name,
    entries: cassette.entries.map((entry) => ({
      key: entry.key,
      request: sortKeys(scrub(entry.request)),
      response: sortKeys(scrub(entry.response)),
    })),
  };
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

/**
 * Load a cassette from disk. Throws if the cassette is missing so tests fail
 * loudly instead of silently hitting the network.
 */
export function loadCassette(name: string): Cassette {
  const path = cassettePath(name);
  if (!existsSync(path)) {
    throw new Error(
      `Cassette "${name}" not found at ${path}. ` +
        `Record it with RPC_RECORD=1 (see src/__tests__/rpcCassette.ts).`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Cassette;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`Cassette "${name}" is malformed: missing entries array.`);
  }
  return parsed;
}

/**
 * EventSource that records request/response pairs and writes them to a
 * cassette on `close()`. Only active when `RPC_RECORD=1`; otherwise it
 * delegates to the provided inner source without writing.
 */
export class RecordingEventSource implements EventSource {
  private readonly entries: CassetteEntry[] = [];
  private closed = false;

  constructor(
    private readonly name: string,
    private readonly inner: EventSource,
  ) {}

  async getEvents(request: JsonValue): Promise<JsonValue> {
    const response = await this.inner.getEvents(request);
    if (isRecording()) {
      this.entries.push({
        key: requestKey(request),
        request: sortKeys(scrub(request)),
        response: sortKeys(scrub(response)),
      });
    }
    return response;
  }

  /**
   * Flush recorded entries to disk. Safe to call multiple times.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (!isRecording()) {
      return;
    }
    ensureCassetteDir();
    const cassette: Cassette = { name: this.name, entries: this.entries };
    writeFileSync(cassettePath(this.name), serializeCassette(cassette), 'utf8');
  }
}

/**
 * EventSource that serves responses strictly from a cassette. Unknown
 * requests throw so tests fail loudly.
 */
export class ReplayEventSource implements EventSource {
  private readonly byKey: Map<string, JsonValue>;
  private readonly consumed = new Set<string>();

  constructor(private readonly cassette: Cassette) {
    this.byKey = new Map();
    for (const entry of cassette.entries) {
      if (this.byKey.has(entry.key)) {
        throw new Error(
          `Cassette "${cassette.name}" has duplicate entry key ${entry.key}.`,
        );
      }
      this.byKey.set(entry.key, entry.response);
    }
  }

  async getEvents(request: JsonValue): Promise<JsonValue> {
    const key = requestKey(request);
    const response = this.byKey.get(key);
    if (response === undefined) {
      throw new Error(
        `ReplayEventSource: unknown request for cassette "${this.cassette.name}" ` +
          `(key ${key}). Request: ${JSON.stringify(sortKeys(scrub(request)))}. ` +
          `Re-record with RPC_RECORD=1 if this is expected.`,
      );
    }
    this.consumed.add(key);
    return response;
  }

  /**
   * Assert that every cassette entry was exercised. Useful in `afterEach`.
   */
  assertFullyConsumed(): void {
    const unused = this.cassette.entries
      .map((e) => e.key)
      .filter((k) => !this.consumed.has(k));
    if (unused.length > 0) {
      throw new Error(
        `ReplayEventSource: cassette "${this.cassette.name}" has unused entries: ` +
          unused.join(', '),
      );
    }
  }
}

/**
 * Convenience factory: returns a recording wrapper when `RPC_RECORD=1`,
 * otherwise a strict replay source loaded from disk.
 */
export function cassetteEventSource(
  name: string,
  inner: EventSource,
): EventSource {
  if (isRecording()) {
    return new RecordingEventSource(name, inner);
  }
  return new ReplayEventSource(loadCassette(name));
}