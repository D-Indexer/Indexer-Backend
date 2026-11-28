import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from 'express';
import type { AddressInfo } from 'net';
import { HttpError } from '../http/errors';

export interface TestResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

export interface TestServer {
  get(path: string, headers?: Record<string, string>): Promise<TestResponse>;
  close(): Promise<void>;
}

/**
 * Serve `routers` on an ephemeral port with an error handler that renders
 * HttpErrors the way the app does (`{ error }` + status), so route tests
 * exercise real Express routing, query parsing and async error propagation.
 */
export async function serve(
  routers: Record<string, Router>,
  middleware: RequestHandler[] = []
): Promise<TestServer> {
  const app = express();
  for (const mw of middleware) app.use(mw);
  for (const [path, router] of Object.entries(routers)) app.use(path, router);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.statusCode : 500;
    res.status(status).json({ error: err instanceof HttpError ? err.message : 'Internal server error' });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    async get(path, headers = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
      return { status: res.status, body: await res.json(), headers: res.headers };
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
