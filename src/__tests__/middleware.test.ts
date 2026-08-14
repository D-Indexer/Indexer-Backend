import { errorHandler } from '../middleware/errorHandler';
import { notFoundHandler } from '../middleware/notFound';
import { requestId } from '../middleware/requestId';
import { securityHeaders } from '../middleware/securityHeaders';
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

    errorHandler(new HttpError(400, 'Bad input'), { id: 'req-123', method: 'GET', originalUrl: '/' } as any, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bad input', requestId: 'req-123' });
    logSpy.mockRestore();
  });
});
