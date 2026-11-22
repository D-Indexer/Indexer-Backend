export class HttpError extends Error {
  readonly statusCode: number;
  readonly expose: boolean;

  constructor(statusCode: number, message: string, expose = statusCode < 500) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.expose = expose;
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

export function methodNotAllowed(method: string, path: string): HttpError {
  const err = new HttpError(405, `Method ${method} is not allowed on ${path}`);
  return err;
}
