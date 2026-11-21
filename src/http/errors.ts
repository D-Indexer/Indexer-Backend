export class HttpError extends Error {
  readonly statusCode: number;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, expose = statusCode < 500, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.expose = expose;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, true, details);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}
