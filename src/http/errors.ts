export class HttpError extends Error {
  readonly statusCode: number;
  readonly expose: boolean;
  /** Extra response headers (e.g. `Retry-After`). */
  readonly headers: Record<string, string>;

  constructor(statusCode: number, message: string, expose = statusCode < 500, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.expose = expose;
    this.headers = headers;
  }
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, true, details);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

/** 425 Too Early: the indexer has not reached the ledger the client asked for yet. */
export function tooEarly(message: string, headers: Record<string, string> = {}): HttpError {
  return new HttpError(425, message, true, headers);
}
