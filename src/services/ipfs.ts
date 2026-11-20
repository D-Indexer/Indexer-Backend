import { createHash } from 'crypto';
import { getEnv } from '../config/env';
import { HttpError } from '../http/errors';

const env = getEnv();

const MAX_FILENAME_LENGTH = 100;
const SAFE_FILENAME_PATTERN = /[^A-Za-z0-9._-]/g;

/**
 * Neutralise a client-supplied filename before it is forwarded to Kubo.
 *
 * - Strips any directory components (path separators, `..`).
 * - Removes control characters (NUL/CR/LF), RTL overrides and any other
 *   character outside `[A-Za-z0-9._-]`.
 * - Collapses leading dots so the result cannot be a hidden/relative name.
 * - Truncates to 100 characters.
 * - Falls back to `upload` when nothing usable remains.
 *
 * The returned value always matches `[A-Za-z0-9._-]{1,100}`.
 */
export function sanitiseFilename(filename: string | undefined | null): string {
  if (typeof filename !== 'string' || filename.length === 0) {
    return 'upload';
  }

  // Take the last path segment, handling both POSIX and Windows separators.
  const segments = filename.split(/[\\/]+/);
  let base = segments[segments.length - 1] ?? '';

  // Remove any character that is not in the safe set (this also strips
  // control characters, NUL/CR/LF and RTL overrides).
  base = base.replace(SAFE_FILENAME_PATTERN, '');

  // Collapse leading dots so we never produce `.`, `..` or hidden names.
  base = base.replace(/^\.+/, '');

  // Collapse repeated dots to avoid confusing names like `a..b`.
  base = base.replace(/\.{2,}/g, '.');

  if (base.length === 0) {
    return 'upload';
  }

  if (base.length > MAX_FILENAME_LENGTH) {
    base = base.slice(0, MAX_FILENAME_LENGTH);
  }

  // Guard against a trailing truncation leaving only dots.
  if (/^\.*$/.test(base)) {
    return 'upload';
  }

  return base;
}

/**
 * Build a server-chosen filename (`upload.<ext>`) from a sniffed MIME type.
 * Falls back to `upload` when no usable extension can be derived.
 */
export function filenameFromMimeType(mimeType: string | undefined | null): string {
  if (typeof mimeType !== 'string' || mimeType.length === 0) {
    return 'upload';
  }

  const subtype = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  if (!subtype) {
    return 'upload';
  }

  // Map a few common subtypes to conventional extensions.
  const aliases: Record<string, string> = {
    jpeg: 'jpg',
    'svg+xml': 'svg',
    'x-icon': 'ico',
    plain: 'txt',
    markdown: 'md',
  };

  const ext = (aliases[subtype] ?? subtype).replace(SAFE_FILENAME_PATTERN, '');
  if (ext.length === 0 || ext.length > 16) {
    return 'upload';
  }

  return `upload.${ext}`;
}

/**
 * Add a file to the configured Kubo node and pin it (`pin=true` is explicit so
 * no separate pin call is needed). Upstream failures surface as 502/504.
 *
 * The filename is always sanitised before being forwarded to Kubo.
 */
export async function pinFile(buffer: Buffer, filename: string): Promise<string> {
  const safeFilename = sanitiseFilename(filename);

  const formData = new FormData();
  formData.append('file', new Blob([buffer]), safeFilename);

  const addUrl = new URL('/api/v0/add', env.IPFS_API_URL);
  addUrl.searchParams.set('pin', 'true');
  addUrl.searchParams.set('cid-version', '1');

  let addResponse: Response;
  try {
    addResponse = await fetch(addUrl, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(env.IPFS_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new HttpError(504, 'IPFS node timed out', true);
    }
    throw new HttpError(502, 'IPFS node unreachable', true);
  }

  if (!addResponse.ok) {
    throw new HttpError(502, `IPFS add failed with status ${addResponse.status}`, true);
  }

  const addResult = (await addResponse.json()) as { Hash?: string };
  if (!addResult.Hash) {
    throw new HttpError(502, 'IPFS add response did not include a CID', true);
  }

  return addResult.Hash;
}

/**
 * Remove a pin from the configured Kubo node. Used by the reconciler and
 * denylist enforcement to unpin content that must no longer be served.
 */
export async function unpinCid(cid: string): Promise<void> {
  const rmUrl = new URL('/api/v0/pin/rm', env.IPFS_API_URL);
  rmUrl.searchParams.set('arg', cid);

  let rmResponse: Response;
  try {
    rmResponse = await fetch(rmUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(env.IPFS_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new HttpError(504, 'IPFS node timed out', true);
    }
    throw new HttpError(502, 'IPFS node unreachable', true);
  }

  // A missing pin is not an error for our purposes.
  if (!rmResponse.ok && rmResponse.status !== 404) {
    throw new HttpError(502, `IPFS pin rm failed with status ${rmResponse.status}`, true);
  }
}

export async function resolveUrl(cid: string): Promise<string> {
  return new URL(cid, `${env.IPFS_GATEWAY.replace(/\/$/, '')}/`).toString();
}

/**
 * Compute the community double-hash denylist entry for a CID:
 * `sha256(CID)` as a lowercase hex string. This lets denylists be shared
 * without republishing the raw CIDs.
 */
export function cidDoubleHash(cid: string): string {
  return createHash('sha256').update(cid, 'utf8').digest('hex');
}

/**
 * A single denylist entry. Either a raw CID or a double-hash (`sha256(CID)`)
 * may be supplied; `hash` is always the double-hash form for storage.
 */
export interface DenylistEntry {
  cid?: string;
  hash?: string;
}

/**
 * Normalise a denylist entry into its double-hash form. Accepts either a raw
 * CID or an already-computed `sha256(CID)` hash.
 */
export function normaliseDenylistEntry(entry: DenylistEntry | string): string {
  if (typeof entry === 'string') {
    // Heuristic: 64 hex chars is a sha256 double-hash, otherwise treat as CID.
    if (/^[0-9a-f]{64}$/i.test(entry)) {
      return entry.toLowerCase();
    }
    return cidDoubleHash(entry);
  }

  if (entry.hash) {
    return entry.hash.toLowerCase();
  }

  if (entry.cid) {
    return cidDoubleHash(entry.cid);
  }

  throw new HttpError(400, 'Denylist entry must include a cid or hash');
}

/**
 * Determine whether a CID is denylisted given a set of normalised
 * double-hash entries.
 */
export function isCidDenylisted(cid: string, denylistHashes: ReadonlySet<string>): boolean {
  if (denylistHashes.size === 0) {
    return false;
  }
  return denylistHashes.has(cidDoubleHash(cid));
}

/**
 * Throw a 451 error when the CID is denylisted. Used by the gateway proxy and
 * upload paths to reject content that must not be served or re-pinned.
 */
export function assertCidAllowed(cid: string, denylistHashes: ReadonlySet<string>): void {
  if (isCidDenylisted(cid, denylistHashes)) {
    throw new HttpError(451, 'Content unavailable for legal reasons', false);
  }
}

/**
 * Reject re-upload of denylisted content. The caller supplies the content hash
 * (e.g. sha256 of the buffer) and the set of denylisted content hashes.
 */
export function assertContentHashAllowed(
  contentHash: string,
  denylistedContentHashes: ReadonlySet<string>,
): void {
  if (denylistedContentHashes.has(contentHash.toLowerCase())) {
    throw new HttpError(451, 'Content unavailable for legal reasons', false);
  }
}