import { badRequest } from './errors';

/** Cursor format version; bump when the payload layout changes. */
const CURSOR_VERSION = 'v1';

export type CursorOrder = 'claimed_at' | 'minted_at' | 'updated_at';

export type ListCursor = {
  order: CursorOrder;
  /** Timestamp of the last row on the previous page (ISO 8601). */
  at: string;
  /** Tie-breaker: the row's primary key (owner address). */
  owner: string;
};

const OWNER_PATTERN = /^[GC][A-Z2-7]{55}$/;

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

/** Build the opaque cursor for the last row of a page. */
export function encodeCursor(cursor: ListCursor): string {
  return encodeBase64Url([CURSOR_VERSION, cursor.order, cursor.at, cursor.owner].join(':'));
}

/**
 * Decode and validate a cursor. Anything that is not a well-formed cursor for
 * `order` (bad base64, wrong version, wrong ordering, unknown owner) is a 400.
 */
export function decodeCursor(raw: string, order: CursorOrder): ListCursor {
  const invalid = () => badRequest('Invalid cursor');

  let decoded: string;
  try {
    decoded = decodeBase64Url(raw);
  } catch {
    throw invalid();
  }

  const parts = decoded.split(':');
  if (parts.length !== 4) throw invalid();

  const [version, cursorOrder, at, owner] = parts;
  if (version !== CURSOR_VERSION) throw invalid();
  if (cursorOrder !== order) throw invalid();
  if (!OWNER_PATTERN.test(owner)) throw invalid();

  const timestamp = new Date(at);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== at) throw invalid();

  return { order, at, owner };
}
