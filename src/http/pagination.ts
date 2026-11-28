import { badRequest } from './errors';

/** Keyset pagination defaults, matching the `…/versions` endpoints (docs/api.md#pagination). */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface PageRequest {
  limit: number;
  /** Decoded cursor key parts, or null for the first page. */
  after: string[] | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Opaque cursor: base64url of a JSON array of the last row's sort-key values.
 * Keys are kept as strings (timestamps are sent at microsecond precision) so
 * the next page compares exactly against what Postgres stored.
 */
export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, arity: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('Invalid cursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== arity ||
    !parsed.every((part): part is string => typeof part === 'string')
  ) {
    throw badRequest('Invalid cursor');
  }
  return parsed;
}

function single(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest(`${name} must be given once`);
  return value;
}

/** Parse `?limit=&cursor=` from an Express query object. */
export function parsePageRequest(query: Record<string, unknown>, arity: number): PageRequest {
  const rawLimit = single(query['limit'], 'limit');
  const rawCursor = single(query['cursor'], 'cursor');

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIMIT) {
      throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
  }

  const after = rawCursor === undefined || rawCursor === '' ? null : decodeCursor(rawCursor, arity);
  return { limit, after };
}

/**
 * Turn `limit + 1` fetched rows into a page: the extra row only signals that
 * another page exists and is dropped.
 */
export function toPage<R, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
  cursorOf: (row: R) => string[]
): Page<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(map),
    nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}

/** Postgres expression rendering a timestamptz as an exact, UTC, microsecond ISO string. */
export function isoMicros(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
