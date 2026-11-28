import { redactUrl } from './redactUrl';

/**
 * Context attached to a captured error. All fields are optional; the scrubber
 * will strip anything sensitive before the payload leaves the process.
 */
export interface ErrorContext {
  /** Correlation id for the request / job that produced the error. */
  requestId?: string;
  /** Route template (e.g. `/api/items/:id`), never the raw URL. */
  route?: string;
  /** Release / version string. */
  release?: string;
  /** Deployment environment (e.g. `production`). */
  environment?: string;
  /** Process that produced the error. */
  process?: 'server' | 'indexer';
  /** Arbitrary extra data; scrubbed aggressively. */
  extra?: Record<string, unknown>;
  /** Raw request info; scrubbed before being sent. */
  request?: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    body?: unknown;
  };
}

export interface ErrorReporter {
  captureError(err: unknown, context?: ErrorContext): void;
}

/** No-op reporter used when tracking is disabled. */
export const noopErrorReporter: ErrorReporter = {
  captureError() {
    /* intentionally empty */
  },
};

/** Headers that are safe to forward to the tracker. */
export const ALLOWED_HEADERS = ['content-type', 'user-agent', 'accept'] as const;

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g;

/** Mask IPv4 / IPv6 addresses found in a string. */
export function maskIpAddresses(value: string): string {
  return value.replace(IPV4_RE, '[redacted-ip]').replace(IPV6_RE, '[redacted-ip]');
}

/** Strip the query string (and fragment) from a URL, keeping the path. */
export function stripQueryString(value: string): string {
  try {
    const url = new URL(value, 'http://placeholder.local');
    if (url.search || url.hash) {
      url.search = '';
      url.hash = '';
      // Preserve relative form when the input was relative.
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
        return `${url.pathname}`;
      }
      return url.toString();
    }
    return value;
  } catch {
    // Not a URL; fall back to naive stripping.
    return value.split('?')[0].split('#')[0];
  }
}

/** Redact a connection string / URL, keeping only scheme + host. */
export function redactConnectionString(value: string): string {
  try {
    return redactUrl(value);
  } catch {
    return '[redacted-url]';
  }
}

/** Keep only allow-listed headers, lower-cased. */
export function scrubHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, raw] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if ((ALLOWED_HEADERS as readonly string[]).includes(lower) && raw !== undefined) {
      const value = Array.isArray(raw) ? raw.join(', ') : raw;
      out[lower] = maskIpAddresses(value);
    }
  }
  return out;
}

/** Recursively scrub a value: redact URLs, connection strings and IPs. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let result = value;
    // Redact anything that looks like a connection string / URL with credentials.
    result = result.replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/[^\s"']+/gi,
      (match) => redactConnectionString(match),
    );
    result = maskIpAddresses(result);
    return result;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (
        lower === 'authorization' ||
        lower === 'cookie' ||
        lower === 'set-cookie' ||
        lower === 'password' ||
        lower === 'secret' ||
        lower === 'token' ||
        lower === 'database_url' ||
        lower === 'databaseurl' ||
        lower === 'dsn'
      ) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = scrubValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Extract a grouping key from an error: class + SQLSTATE / RPC code. */
export function groupingKey(err: unknown): string {
  const parts: string[] = [];
  const name =
    err instanceof Error ? err.name || err.constructor?.name || 'Error' : typeof err;
  parts.push(name);

  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    const sqlState = anyErr.code ?? anyErr.sqlState ?? anyErr.sqlstate;
    if (typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState)) {
      parts.push(`sqlstate:${sqlState}`);
    } else if (typeof sqlState === 'string') {
      parts.push(`code:${sqlState}`);
    }
    const rpcCode = anyErr.rpcCode ?? anyErr.rpc_code;
    if (typeof rpcCode === 'number' || typeof rpcCode === 'string') {
      parts.push(`rpc:${rpcCode}`);
    }
  }
  return parts.join('|');
}

export interface ScrubbedPayload {
  message: string;
  name: string;
  stack?: string;
  groupingKey: string;
  requestId?: string;
  route?: string;
  release?: string;
  environment?: string;
  process?: string;
  request?: {
    method?: string;
    url?: string;
    headers: Record<string, string>;
  };
  extra?: Record<string, unknown>;
}

/** Build a fully scrubbed payload from an error and its context. */
export function scrubError(err: unknown, context: ErrorContext = {}): ScrubbedPayload {
  const isError = err instanceof Error;
  const message = isError ? err.message : String(err);
  const name = isError ? err.name || 'Error' : typeof err;
  const stack = isError && err.stack ? maskIpAddresses(err.stack) : undefined;

  const payload: ScrubbedPayload = {
    message: maskIpAddresses(message),
    name,
    groupingKey: groupingKey(err),
  };
  if (stack) payload.stack = stack;
  if (context.requestId) payload.requestId = context.requestId;
  if (context.route) payload.route = stripQueryString(context.route);
  if (context.release) payload.release = context.release;
  if (context.environment) payload.environment = context.environment;
  if (context.process) payload.process = context.process;

  if (context.request) {
    const req: ScrubbedPayload['request'] = {};
    if (context.request.method) req.method = context.request.method;
    if (context.request.url) req.url = stripQueryString(context.request.url);
    req.headers = scrubHeaders(context.request.headers);
    // Request bodies are always dropped.
    payload.request = req;
  }

  if (context.extra) {
    payload.extra = scrubValue(context.extra) as Record<string, unknown>;
  }

  return payload;
}

/** Transport abstraction so the SDK can be swapped / mocked in tests. */
export interface ErrorTransport {
  send(payload: ScrubbedPayload): void;
}

/** Reporter that scrubs and forwards to a transport. */
export function createScrubbingReporter(transport: ErrorTransport): ErrorReporter {
  return {
    captureError(err: unknown, context?: ErrorContext) {
      try {
        transport.send(scrubError(err, context));
      } catch {
        // Never let the reporter throw into the caller.
      }
    },
  };
}

export interface ErrorReporterOptions {
  dsn?: string;
  release?: string;
  environment?: string;
  transport?: ErrorTransport;
}

/**
 * Factory: returns the no-op reporter when no DSN is configured (zero
 * overhead), otherwise a scrubbing reporter backed by the given transport.
 */
export function createErrorReporter(options: ErrorReporterOptions = {}): ErrorReporter {
  const dsn = options.dsn ?? process.env.ERROR_TRACKING_DSN;
  if (!dsn) return noopErrorReporter;

  const transport: ErrorTransport =
    options.transport ??
    ({
      send(payload: ScrubbedPayload) {
        // Placeholder transport: wire up the third-party SDK here.
        // The payload is already scrubbed at this point.
        void payload;
      },
    } satisfies ErrorTransport);

  return createScrubbingReporter(transport);
}
```

```typescript
// src/utils/errorReporter.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  scrubError,
  scrubHeaders,
  stripQueryString,
  maskIpAddresses,
  groupingKey,
  createErrorReporter,
  noopErrorReporter,
  type ErrorTransport,
  type ScrubbedPayload,
} from './errorReporter';

const SENSITIVE = [
  'super-secret-token',
  'password123',
  '192.168.1.42',
  '10.0.0.7',
  'postgres://user:pass@db.internal:5432/app',
  'https://rpc.example.com/v1/abc123key',
];

describe('errorReporter scrubber', () => {
  it('strips query strings from URLs', () => {
    expect(stripQueryString('/api/items?token=abc&x=1')).toBe('/api/items');
    expect(stripQueryString('https://api.example.com/path?key=secret#frag')).toBe(
      'https://api.example.com/path',
    );
  });

  it('masks IP addresses', () => {
    expect(maskIpAddresses('from 192.168.1.42 and 10.0.0.7')).toBe(
      'from [redacted-ip] and [redacted-ip]',
    );
  });

  it('keeps only allow-listed headers', () => {
    const headers = scrubHeaders({
      'content-type': 'application/json',
      'user-agent': 'test-agent',
      authorization: 'Bearer super-secret-token',
      cookie: 'session=password123',
      'x-forwarded-for': '192.168.1.42',
    });
    expect(headers).toEqual({
      'content-type': 'application/json',
      'user-agent': 'test-agent',
    });
  });

  it('groups indexer errors by class and SQLSTATE / RPC code', () => {
    const sqlErr = Object.assign(new Error('boom'), { code: '23505' });
    expect(groupingKey(sqlErr)).toBe('Error|sqlstate:23505');

    const rpcErr = Object.assign(new Error('rpc failed'), { rpcCode: -32000 });
    expect(groupingKey(rpcErr)).toBe('Error|rpc:-32000');
  });

  it('produces a scrubbed payload with no sensitive fields', () => {
    const err = Object.assign(new Error('failed to reach 192.168.1.42'), {
      code: '08006',
    });
    const payload = scrubError(err, {
      requestId: 'req-1',
      route: '/api/items/:id?token=super-secret-token',
      release: '1.2.3',
      environment: 'production',
      process: 'server',
      request: {
        method: 'POST',
        url: '/api/items/1?token=super-secret-token',
        headers: {
          authorization: 'Bearer super-secret-token',
          cookie: 'session=password123',
          'x-forwarded-for': '192.168.1.42',
          'content-type': 'application/json',
        },
        body: { password: 'password123', token: 'super-secret-token' },
      },
      extra: {
        databaseUrl: 'postgres://user:pass@db.internal:5432/app',
        rpcUrl: 'https://rpc.example.com/v1/abc123key',
        clientIp: '10.0.0.7',
      },
    });

    const serialized = JSON.stringify(payload);
    for (const secret of SENSITIVE) {
      expect(serialized).not.toContain(secret);
    }
    expect(payload.request?.url).toBe('/api/items/1');
    expect(payload.route).toBe('/api/items/:id');
    expect(payload.request?.headers).toEqual({ 'content-type': 'application/json' });
    expect(payload.request).not.toHaveProperty('body');
    expect(payload.groupingKey).toBe('Error|sqlstate:08006');
  });

  it('returns the no-op reporter when no DSN is configured', () => {
    const reporter = createErrorReporter({ dsn: '' });
    expect(reporter).toBe(noopErrorReporter);
  });

  it('sends scrubbed payloads through the transport when a DSN is set', () => {
    const send = vi.fn<(payload: ScrubbedPayload) => void>();
    const transport: ErrorTransport = { send };
    const reporter = createErrorReporter({ dsn: 'https://dsn.example.com/1', transport });

    reporter.captureError(new Error('boom at 192.168.1.42'), {
      request: { url: '/x?token=super-secret-token', headers: { cookie: 'password123' } },
    });

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0];
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('password123');
    expect(serialized).not.toContain('192.168.1.42');
  });
});