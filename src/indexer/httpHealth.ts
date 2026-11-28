import http from 'http';
import { AddressInfo } from 'net';

/**
 * In-memory health state for the indexer process.
 *
 * This is intentionally lightweight: it only tracks the liveness of the
 * indexer loop and the freshness of the last successful page. It is updated
 * from the indexer loop and read by the embedded HTTP health server.
 */
export interface HealthState {
  /** Timestamp (ms) when the last tick finished, or null if none yet. */
  lastTickAt: number | null;
  /** Timestamp (ms) of the last successful page, or null if none yet. */
  lastPageAt: number | null;
  /** Current page being processed, or null if unknown. */
  currentPage: number | null;
  /** Number of consecutive failures. */
  failures: number;
  /** Current backoff in milliseconds. */
  backoffMs: number;
  /** Whether the indexer has been halted. */
  halted: boolean;
}

export interface HealthConfig {
  /** Poll interval in ms; used to derive the tick liveness window. */
  pollIntervalMs: number;
  /** Multiplier applied to pollIntervalMs to derive the tick window. */
  tickWindowMultiplier: number;
  /** Max age (ms) of the last successful page before readiness fails. */
  staleAfterMs: number;
}

const DEFAULT_TICK_WINDOW_MULTIPLIER = 3;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function loadHealthConfig(env: NodeJS.ProcessEnv = process.env): HealthConfig {
  return {
    pollIntervalMs: parsePositiveInt(env.INDEXER_POLL_INTERVAL_MS, 5000),
    tickWindowMultiplier: parsePositiveInt(
      env.INDEXER_TICK_WINDOW_MULTIPLIER,
      DEFAULT_TICK_WINDOW_MULTIPLIER,
    ),
    staleAfterMs: parsePositiveInt(env.INDEXER_STALE_AFTER_MS, 300_000),
  };
}

export function createHealthState(): HealthState {
  return {
    lastTickAt: null,
    lastPageAt: null,
    currentPage: null,
    failures: 0,
    backoffMs: 0,
    halted: false,
  };
}

export interface HealthReport {
  ok: boolean;
  state: HealthState;
  /** Reason the check failed, if any. */
  reason?: string;
  /** Age of the last tick in ms, or null if none. */
  tickAgeMs: number | null;
  /** Age of the last successful page in ms, or null if none. */
  pageAgeMs: number | null;
}

function ageOf(timestamp: number | null, now: number): number | null {
  if (timestamp === null) {
    return null;
  }
  return Math.max(0, now - timestamp);
}

/**
 * Evaluate liveness: the process loop must have finished a tick within
 * `tickWindowMultiplier * pollIntervalMs` and must not be halted.
 */
export function evaluateHealth(
  state: HealthState,
  config: HealthConfig,
  now: number = Date.now(),
): HealthReport {
  const tickAgeMs = ageOf(state.lastTickAt, now);
  const pageAgeMs = ageOf(state.lastPageAt, now);
  const windowMs = config.pollIntervalMs * config.tickWindowMultiplier;

  if (state.halted) {
    return { ok: false, state, reason: 'halted', tickAgeMs, pageAgeMs };
  }
  if (tickAgeMs === null) {
    return { ok: false, state, reason: 'no-tick-yet', tickAgeMs, pageAgeMs };
  }
  if (tickAgeMs > windowMs) {
    return { ok: false, state, reason: 'tick-stale', tickAgeMs, pageAgeMs };
  }
  return { ok: true, state, tickAgeMs, pageAgeMs };
}

/**
 * Evaluate readiness: the last successful page must be within
 * `staleAfterMs` and the indexer must not be halted.
 */
export function evaluateReadiness(
  state: HealthState,
  config: HealthConfig,
  now: number = Date.now(),
): HealthReport {
  const tickAgeMs = ageOf(state.lastTickAt, now);
  const pageAgeMs = ageOf(state.lastPageAt, now);

  if (state.halted) {
    return { ok: false, state, reason: 'halted', tickAgeMs, pageAgeMs };
  }
  if (pageAgeMs === null) {
    return { ok: false, state, reason: 'no-page-yet', tickAgeMs, pageAgeMs };
  }
  if (pageAgeMs > config.staleAfterMs) {
    return { ok: false, state, reason: 'page-stale', tickAgeMs, pageAgeMs };
  }
  return { ok: true, state, tickAgeMs, pageAgeMs };
}

/**
 * Mutable health tracker used by the indexer loop to record progress.
 */
export class HealthTracker {
  private readonly state: HealthState;
  private readonly config: HealthConfig;

  constructor(config: HealthConfig = loadHealthConfig(), state: HealthState = createHealthState()) {
    this.config = config;
    this.state = state;
  }

  getConfig(): HealthConfig {
    return this.config;
  }

  getState(): HealthState {
    return { ...this.state };
  }

  /** Record that a tick finished successfully. */
  recordTick(now: number = Date.now()): void {
    this.state.lastTickAt = now;
  }

  /** Record that a page was processed successfully. */
  recordPage(page: number, now: number = Date.now()): void {
    this.state.currentPage = page;
    this.state.lastPageAt = now;
    this.state.failures = 0;
    this.state.backoffMs = 0;
  }

  /** Record a failure and the resulting backoff. */
  recordFailure(backoffMs: number): void {
    this.state.failures += 1;
    this.state.backoffMs = backoffMs;
  }

  /** Mark the indexer as halted. */
  markHalted(): void {
    this.state.halted = true;
  }

  health(now: number = Date.now()): HealthReport {
    return evaluateHealth(this.state, this.config, now);
  }

  readiness(now: number = Date.now()): HealthReport {
    return evaluateReadiness(this.state, this.config, now);
  }
}

export interface HealthServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * Start the embedded HTTP health server on the given port.
 *
 * Exposes:
 *   GET /healthz - liveness (process loop alive, not halted)
 *   GET /readyz  - readiness (recent successful page, not halted)
 */
export function startHealthServer(
  tracker: HealthTracker,
  port: number = parsePositiveInt(process.env.INDEXER_HTTP_PORT, 8081),
  host: string = '0.0.0.0',
): Promise<HealthServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, reason: 'method-not-allowed' });
      return;
    }

    if (path === '/healthz') {
      const report = tracker.health();
      sendJson(res, report.ok ? 200 : 503, report);
      return;
    }

    if (path === '/readyz') {
      const report = tracker.readiness();
      sendJson(res, report.ok ? 200 : 503, report);
      return;
    }

    sendJson(res, 404, { ok: false, reason: 'not-found' });
  });

  return new Promise<HealthServer>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address() as AddressInfo | null;
      const boundPort = address && typeof address === 'object' ? address.port : port;
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) {
                rejectClose(err);
              } else {
                resolveClose();
              }
            });
          }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}