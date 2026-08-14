import { NextFunction, Request, RequestHandler, Response } from 'express';

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
