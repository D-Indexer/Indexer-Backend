import { errorHandler } from '../middleware/errorHandler';
import { notFoundHandler } from '../middleware/notFound';
import { requestId } from '../middleware/requestId';
import { securityHeaders } from '../middleware/securityHeaders';
import {
  createUploadQuotaMiddleware,
  hashClientIp,
  UploadQuotaStore,
} from '../middleware/uploadQuota';
import { HttpError } from '../http/errors';
import { mockResponse } from './testUtils';

describe('middleware', () => {
  it('propagates incoming request ids', () => {
    const req = { header: jest.fn().mockReturnValue('req-123') } as any;
    const res = mockResponse();
    const next = jest.fn();

    requestId(req, res, next);

    expect(req.id).toBe('req-123');
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'req-123');
    expect(next).toHaveBeenCalled();
  });

  it.each(['x'.repeat(129), 'bad id with spaces', 'inject\r\nheader'])(
    'replaces unsafe incoming request id %#',
    (incoming) => {
      const req = { header: jest.fn().mockReturnValue(incoming) } as any;
      requestId(req, mockResponse(), jest.fn());
      expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  );

  it('sets security headers', () => {
    const res = mockResponse();
    const next = jest.fn();

    securityHeaders({} as any, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('x-content-type-options', 'nosniff');
    expect(res.setHeader).toHaveBeenCalledWith('x-frame-options', 'DENY');
    expect(next).toHaveBeenCalled();
  });

  it('returns route not found responses', () => {
    const res = mockResponse();

    notFoundHandler({ originalUrl: '/missing', id: 'req-123' } as any, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Route not found',
      path: '/missing',
      requestId: 'req-123',
    });
  });

  it('exposes expected HTTP errors', () => {
    const res = mockResponse();
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    errorHandler(
      new HttpError(400, 'Bad input'),
      { id: 'req-123', method: 'GET', originalUrl: '/' } as any,
      res,
      jest.fn()
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bad input', requestId: 'req-123' });
    logSpy.mockRestore();
  });
});

describe('upload quota middleware', () => {
  const SALT = 'test-salt';
  const IP = '203.0.113.7';
  const HASH = 'a'.repeat(64);

  function makeClock(start: Date) {
    let now = start.getTime();
    return {
      now: () => new Date(now),
      advance: (ms: number) => {
        now += ms;
      },
      set: (date: Date) => {
        now = date.getTime();
      },
    };
  }

  function makeReq(overrides: Record<string, unknown> = {}) {
    return {
      ip: IP,
      body: {},
      header: jest.fn().mockReturnValue(undefined),
      ...overrides,
    } as any;
  }

  function makeStore(clock: ReturnType<typeof makeClock>) {
    return new UploadQuotaStore({ now: clock.now });
  }

  it('returns 429 with a reset time when the daily byte quota is exceeded', () => {
    const clock = makeClock(new Date('2024-05-01T10:00:00.000Z'));
    const store = makeStore(clock);
    const middleware = createUploadQuotaMiddleware({
      store,
      salt: SALT,
      maxDailyBytes: 100,
      maxDailyFiles: 100,
      now: clock.now,
    });
    const next = jest.fn();

    middleware(makeReq({ body: { size: 60 } }), mockResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);

    const res = mockResponse();
    middleware(makeReq({ body: { size: 60 } }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(429);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.error).toBeDefined();
    expect(payload.resetAt).toBe('2024-05-02T00:00:00.000Z');
    expect(res.setHeader).toHaveBeenCalledWith('retry-after', expect.any(String));
  });

  it('enforces the daily file-count quota', () => {
    const clock = makeClock(new Date('2024-05-01T10:00:00.000Z'));
    const store = makeStore(clock);
    const middleware = createUploadQuotaMiddleware({
      store,
      salt: SALT,
      maxDailyBytes: 1_000_000,
      maxDailyFiles: 2,
      now: clock.now,
    });
    const next = jest.fn();

    middleware(makeReq({ body: { size: 1 } }), mockResponse(), next);
    middleware(makeReq({ body: { size: 1 } }), mockResponse(), next);
    expect(next).toHaveBeenCalledTimes(2);

    const res = mockResponse();
    middleware(makeReq({ body: { size: 1 } }), res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(429);
    expect((res.json as jest.Mock).mock.calls[0][0].resetAt).toBe('2024-05-02T00:00:00.000Z');
  });

  it('rolls the quota window over at UTC midnight', () => {
    const clock = makeClock(new Date('2024-05-01T23:59:00.000Z'));
    const store = makeStore(clock);
    const middleware = createUploadQuotaMiddleware({
      store,
      salt: SALT,
      maxDailyBytes: 100,
      maxDailyFiles: 100,
      now: clock.now,
    });
    const next = jest.fn();

    middleware(makeReq({ body: { size: 100 } }), mockResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);

    const blocked = mockResponse();
    middleware(makeReq({ body: { size: 1 } }), blocked, next);
    expect(blocked.status).toHaveBeenCalledWith(429);

    clock.set(new Date('2024-05-02T00:00:00.000Z'));

    const res = mockResponse();
    middleware(makeReq({ body: { size: 100 } }), res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalledWith(429);
  });

  it('rejects blocklisted content hashes before pinning', () => {
    const clock = makeClock(new Date('2024-05-01T10:00:00.000Z'));
    const store = makeStore(clock);
    store.blockContentHash(HASH);
    const middleware = createUploadQuotaMiddleware({
      store,
      salt: SALT,
      maxDailyBytes: 1_000_000,
      maxDailyFiles: 100,
      now: clock.now,
    });
    const next = jest.fn();
    const res = mockResponse();

    middleware(makeReq({ body: { size: 10, sha256: HASH } }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(store.getUsage(hashClientIp(IP, SALT), clock.now()).bytes).toBe(0);
  });

  it('persists only a salted hash of the client IP', () => {
    const clock = makeClock(new Date('2024-05-01T10:00:00.000Z'));
    const store = makeStore(clock);
    const middleware = createUploadQuotaMiddleware({
      store,
      salt: SALT,
      maxDailyBytes: 1_000_000,
      maxDailyFiles: 100,
      now: clock.now,
    });

    middleware(makeReq({ body: { size: 42 } }), mockResponse(), jest.fn());

    const keys = store.listClientKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(IP);
    expect(keys[0]).toBe(hashClientIp(IP, SALT));
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
