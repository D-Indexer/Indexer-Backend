import { NextFunction, Request, RequestHandler, Response } from 'express';
import { runWithContext, RequestContext } from '../utils/context';

export function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res;
}

export async function invokeHandler(
  handler: RequestHandler,
  req: Partial<Request>,
  res: Response = mockResponse()
): Promise<{ res: Response; next: jest.MockedFunction<NextFunction> }> {
  const next = jest.fn() as jest.MockedFunction<NextFunction>;
  const result = handler(req as Request, res, next) as unknown;

  if (result && typeof (result as Promise<unknown>).then === 'function') {
    await result;
  }

  await new Promise(process.nextTick);

  return { res, next };
}

/**
 * Run `fn` inside a fresh request context. Useful for tests that need to
 * exercise code paths relying on AsyncLocalStorage-backed context.
 */
export function runInRequestContext<T>(
  context: Partial<RequestContext>,
  fn: () => T
): T {
  return runWithContext(context, fn);
}

/**
 * Build a fake async dependency that records how many times it was called
 * and how long each call took. The `delayMs` controls the simulated latency.
 */
export interface FakeTimedDependency {
  fn: <T>(result: T) => Promise<T>;
  calls: number;
  totalDurationMs: number;
}

export function createFakeTimedDependency(delayMs = 0): FakeTimedDependency {
  const dep: FakeTimedDependency = {
    calls: 0,
    totalDurationMs: 0,
    fn: async <T>(result: T): Promise<T> => {
      const start = process.hrtime.bigint();
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const end = process.hrtime.bigint();
      dep.calls += 1;
      dep.totalDurationMs += Number(end - start) / 1e6;
      return result;
    },
  };
  return dep;
}