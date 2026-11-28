import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

/**
 * Timing data accumulated on the request context by instrumented
 * dependencies (database client, upstream fetches, etc.).
 */
export interface RequestTimings {
  /** Total time spent in database queries, in milliseconds. */
  dbDurationMs: number;
  /** Number of database queries executed during the request. */
  dbCount: number;
  /** Total time spent in upstream (IPFS/Kubo) fetches, in milliseconds. */
  ipfsDurationMs: number;
  /** Number of upstream fetches executed during the request. */
  ipfsCount: number;
  /** Timestamp (ms since epoch) when the request started. */
  startTime: number;
}

const TIMINGS_KEY = 'timings';

/**
 * Retrieve (or lazily create) the timings bag attached to the request.
 * Instrumented dependencies call this to record their work.
 */
export function getRequestTimings(req: Request): RequestTimings {
  const existing = (req as Request & { [TIMINGS_KEY]?: RequestTimings })[TIMINGS_KEY];
  if (existing) {
    return existing;
  }

  const created: RequestTimings = {
    dbDurationMs: 0,
    dbCount: 0,
    ipfsDurationMs: 0,
    ipfsCount: 0,
    startTime: Date.now(),
  };
  (req as Request & { [TIMINGS_KEY]?: RequestTimings })[TIMINGS_KEY] = created;
  return created;
}

/** Record a database query's duration. */
export function recordDbTiming(req: Request, durationMs: number): void {
  const timings = getRequestTimings(req);
  timings.dbDurationMs += durationMs;
  timings.dbCount += 1;
}

/** Record an upstream (IPFS) fetch's duration. */
export function recordIpfsTiming(req: Request, durationMs: number): void {
  const timings = getRequestTimings(req);
  timings.ipfsDurationMs += durationMs;
  timings.ipfsCount += 1;
}

function formatDuration(ms: number): string {
  // Server-Timing durations are in milliseconds; keep one decimal place.
  return (Math.round(ms * 10) / 10).toString();
}

function escapeDesc(desc: string): string {
  return desc.replace(/["\\]/g, '\\$&');
}

/**
 * Build the Server-Timing header value from the accumulated timings.
 */
export function buildServerTimingHeader(timings: RequestTimings, appDurationMs: number): string {
  const parts: string[] = [];

  if (timings.dbCount > 0) {
    const desc = `${timings.dbCount} ${timings.dbCount === 1 ? 'query' : 'queries'}`;
    parts.push(`db;dur=${formatDuration(timings.dbDurationMs)};desc="${escapeDesc(desc)}"`);
  }

  if (timings.ipfsCount > 0) {
    parts.push(`ipfs;dur=${formatDuration(timings.ipfsDurationMs)}`);
  }

  parts.push(`app;dur=${formatDuration(appDurationMs)}`);

  return parts.join(', ');
}

/**
 * Whether Server-Timing should be emitted for the current environment.
 * Enabled in non-production by default; in production only when
 * SERVER_TIMING=true is explicitly set.
 */
function isServerTimingEnabled(): boolean {
  const flag = env.SERVER_TIMING;
  if (flag !== undefined) {
    return flag === true || flag === 'true' || flag === '1';
  }
  return env.NODE_ENV !== 'production';
}

/**
 * In production, emit coarse (rounded) timings unless explicitly enabled.
 */
function isCoarseMode(): boolean {
  const flag = env.SERVER_TIMING;
  const explicitlyEnabled = flag === true || flag === 'true' || flag === '1';
  return env.NODE_ENV === 'production' && !explicitlyEnabled;
}

function roundCoarse(ms: number): number {
  // Round to the nearest 10ms in coarse mode to avoid leaking fine-grained info.
  return Math.round(ms / 10) * 10;
}

/**
 * Express middleware that emits a `Server-Timing` header with a breakdown of
 * database, upstream, and application time, and logs a warning for slow
 * requests.
 */
export function serverTiming(req: Request, res: Response, next: NextFunction): void {
  const timings = getRequestTimings(req);
  timings.startTime = Date.now();

  const enabled = isServerTimingEnabled();
  const coarse = isCoarseMode();

  res.on('finish', () => {
    const totalDurationMs = Date.now() - timings.startTime;

    // Application time = total time minus time spent in instrumented deps.
    const appDurationMs = Math.max(
      0,
      totalDurationMs - timings.dbDurationMs - timings.ipfsDurationMs,
    );

    const effectiveTimings: RequestTimings = coarse
      ? {
          ...timings,
          dbDurationMs: roundCoarse(timings.dbDurationMs),
          ipfsDurationMs: roundCoarse(timings.ipfsDurationMs),
        }
      : timings;

    const effectiveAppDurationMs = coarse ? roundCoarse(appDurationMs) : appDurationMs;

    if (enabled && !res.headersSent) {
      try {
        res.setHeader(
          'Server-Timing',
          buildServerTimingHeader(effectiveTimings, effectiveAppDurationMs),
        );
      } catch {
        // Header may already be sent; ignore.
      }
    }

    const slowThresholdMs = env.SLOW_REQUEST_THRESHOLD_MS;
    if (totalDurationMs >= slowThresholdMs) {
      const breakdown = {
        method: req.method,
        path: req.originalUrl ?? req.url,
        totalMs: Math.round(totalDurationMs * 10) / 10,
        dbMs: Math.round(timings.dbDurationMs * 10) / 10,
        dbQueries: timings.dbCount,
        ipfsMs: Math.round(timings.ipfsDurationMs * 10) / 10,
        ipfsFetches: timings.ipfsCount,
        appMs: Math.round(appDurationMs * 10) / 10,
      };
      // eslint-disable-next-line no-console
      console.warn('[server-timing] slow request', breakdown);
    }
  });

  next();
}

export default serverTiming;