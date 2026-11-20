import { errorHandler } from '../middleware/errorHandler';
import { notFoundHandler } from '../middleware/notFound';
import { requestId } from '../middleware/requestId';
import { securityHeaders } from '../middleware/securityHeaders';
import { serverTiming } from '../middleware/serverTiming';
import { HttpError } from '../http/errors';
import { mockResponse } from './testUtils';
import { getContext, runWithContext } from '../utils/context';

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

  it('isolates request contexts across interleaved async work', async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const runRequest = (requestId: string, wait: number) =>
      runWithContext({ requestId }, async () => {
        const seen: string[] = [];
        seen.push(getContext()?.requestId as string);
        await delay(wait);
        seen.push(getContext()?.requestId as string);
        await delay(wait);
        seen.push(getContext()?.requestId as string);
        return seen;
      });

    const [first, second] = await Promise.all([
      runRequest('req-a', 15),
      runRequest('req-b', 5),
    ]);

    expect(first).toEqual(['req-a', 'req-a', 'req-a']);
    expect(second).toEqual(['req-b', 'req-b', 'req-b']);
    expect(getContext()).toBeUndefined();
  });

  it('emits accurate Server-Timing entries for timed dependencies', () => {
    const res = mockResponse();
    const next = jest.fn();
    const middleware = serverTiming({ enabled: true, slowThresholdMs: 10_000 });

    runWithContext({ requestId: 'req-123' }, () => {
      middleware({} as any, res, next);
      const ctx = getContext() as any;
      ctx.timings.db = { count: 3, durationMs: 12.3 };
      ctx.timings.ipfs = { count: 1, durationMs: 850 };
      ctx.timings.app = { count: 0, durationMs: 4 };
      res.emit('finish');
    });

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      'Server-Timing',
      'db;dur=12.3;desc="3 queries", ipfs;dur=850;desc="1 call", app;dur=4'
    );
  });

  it('omits Server-Timing when disabled', () => {
    const res = mockResponse();
    const middleware = serverTiming({ enabled: false, slowThresholdMs: 10_000 });

    runWithContext({ requestId: 'req-123' }, () => {
      middleware({} as any, res, jest.fn());
      const ctx = getContext() as any;
      ctx.timings.db = { count: 1, durationMs: 5 };
      res.emit('finish');
    });

    expect(res.setHeader).not.toHaveBeenCalledWith('Server-Timing', expect.anything());
  });

  it('logs a warning with the breakdown for slow requests', () => {
    const res = mockResponse();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const middleware = serverTiming({ enabled: true, slowThresholdMs: 100 });

    runWithContext({ requestId: 'req-slow' }, () => {
      middleware({} as any, res, jest.fn());
      const ctx = getContext() as any;
      ctx.timings.db = { count: 2, durationMs: 60 };
      ctx.timings.ipfs = { count: 1, durationMs: 120 };
      ctx.timings.app = { count: 0, durationMs: 10 };
      res.emit('finish');
    });

    expect(warnSpy).toHaveBeenCalled();
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain('req-slow');
    expect(message).toContain('db');
    expect(message).toContain('ipfs');
    warnSpy.mockRestore();
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
