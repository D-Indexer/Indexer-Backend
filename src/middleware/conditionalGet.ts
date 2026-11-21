import { createHash } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { getEnv } from '../config/env';

/** Bump when a response body shape changes so cached copies are invalidated. */
export const RESPONSE_SHAPE_VERSION = 'v1';

/** Strong ETag for one resource: shape version + its last change marker. */
export function resourceEtag(marker: string | Date | null | undefined): string {
  const value = marker instanceof Date ? marker.toISOString() : (marker ?? 'none');
  const hash = createHash('sha256').update(`${RESPONSE_SHAPE_VERSION}:${value}`).digest('base64url');
  return `"${hash.slice(0, 27)}"`;
}

/** Strong ETag for a collection: shape version + count + newest change marker. */
export function collectionEtag(items: Array<{ marker: string | Date | null | undefined }>): string {
  let newest: string | null = null;
  for (const item of items) {
    const value = item.marker instanceof Date ? item.marker.toISOString() : (item.marker ?? null);
    if (value !== null && (newest === null || value > newest)) newest = value;
  }
  return resourceEtag(`count=${items.length};newest=${newest ?? 'none'}`);
}

function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag);
}

function notModifiedSince(header: string, lastModified: Date): boolean {
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  // HTTP dates have second precision.
  return Math.floor(lastModified.getTime() / 1000) * 1000 <= since;
}

/**
 * Conditional GET for read endpoints: sets `Cache-Control`, `ETag` and
 * `Last-Modified`, and answers `304 Not Modified` (no body) when the client's
 * `If-None-Match` / `If-Modified-Since` still matches.
 */
export function conditionalGet(etag: string, lastModified: Date | null, req: Request, res: Response): void {
  const env = getEnv();
  res.setHeader(
    'Cache-Control',
    env.API_CACHE_MAX_AGE_S > 0
      ? `public, max-age=${env.API_CACHE_MAX_AGE_S}, stale-while-revalidate=${env.API_CACHE_SWR_S}`
      : 'no-store'
  );
  res.setHeader('ETag', etag);
  if (lastModified) res.setHeader('Last-Modified', lastModified.toUTCString());

  const ifNoneMatch = req.header('if-none-match');
  const ifModifiedSince = req.header('if-modified-since');

  const fresh = ifNoneMatch
    ? etagMatches(ifNoneMatch, etag)
    : ifModifiedSince && lastModified
      ? notModifiedSince(ifModifiedSince, lastModified)
      : false;

  if (fresh) {
    res.status(304).end();
    return;
  }

  res.setHeader('Vary', 'Origin');
}

/** `Cache-Control: no-store` for endpoints whose responses must never be cached. */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
