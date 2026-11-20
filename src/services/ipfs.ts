import { getEnv } from '../config/env';
import { HttpError } from '../http/errors';

const env = getEnv();

/**
 * Add a file to the configured Kubo node and pin it (`pin=true` is explicit so
 * no separate pin call is needed). Upstream failures surface as 502/504.
 */
export async function pinFile(buffer: Buffer, filename: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', new Blob([buffer]), filename);

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
 * Import a CARv1 file into the configured Kubo node via `/api/v0/dag/import`
 * with `pin-roots=true`. Returns the root CID reported by Kubo.
 *
 * The caller is responsible for validating the CAR (single root, block hashes
 * matching CIDs, allowed content types) before invoking this function.
 */
export async function importCar(carBuffer: Buffer): Promise<string> {
  const formData = new FormData();
  formData.append('file', new Blob([carBuffer]), 'upload.car');

  const importUrl = new URL('/api/v0/dag/import', env.IPFS_API_URL);
  importUrl.searchParams.set('pin-roots', 'true');

  let importResponse: Response;
  try {
    importResponse = await fetch(importUrl, {
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

  if (!importResponse.ok) {
    throw new HttpError(502, `IPFS dag import failed with status ${importResponse.status}`, true);
  }

  // Kubo streams newline-delimited JSON objects. The root pin record has
  // `Root: { Cid: { "/": "<cid>" } }`. We read the whole (small) response.
  const text = await importResponse.text();
  let rootCid: string | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = parsed as {
      Root?: { Cid?: { '/': string } | string };
    };
    const cidField = record.Root?.Cid;
    if (typeof cidField === 'string') {
      rootCid = cidField;
      break;
    }
    if (cidField && typeof cidField === 'object' && typeof cidField['/'] === 'string') {
      rootCid = cidField['/'];
      break;
    }
  }

  if (!rootCid) {
    throw new HttpError(502, 'IPFS dag import response did not include a root CID', true);
  }

  return rootCid;
}

/**
 * Open a streaming fetch against Kubo `/api/v0/cat` for the given CID/path.
 * The upstream `Response` is returned as-is so the caller can pipe
 * `response.body` directly to the client without buffering the whole file.
 *
 * `range` is forwarded verbatim (e.g. `bytes=0-1023`) so Kubo can serve
 * partial content.
 */
export async function fetchCatStream(
  cid: string,
  path: string,
  range?: string,
): Promise<Response> {
  const catUrl = new URL('/api/v0/cat', env.IPFS_API_URL);
  catUrl.searchParams.set('arg', path ? `${cid}/${path}` : cid);

  const headers: Record<string, string> = {};
  if (range) {
    headers['Range'] = range;
  }

  let catResponse: Response;
  try {
    catResponse = await fetch(catUrl, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(env.IPFS_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new HttpError(504, 'IPFS node timed out', true);
    }
    throw new HttpError(502, 'IPFS node unreachable', true);
  }

  if (catResponse.status === 404) {
    throw new HttpError(404, 'Content not found');
  }
  if (!catResponse.ok && catResponse.status !== 206) {
    throw new HttpError(502, `IPFS cat failed with status ${catResponse.status}`, true);
  }

  return catResponse;
}

/**
 * Allow-list check: returns true when the CID is referenced by an indexed
 * portfolio, template, or tracked upload. Unreferenced CIDs must be rejected
 * (404) before contacting Kubo.
 *
 * The lookup is delegated to a caller-provided resolver so this service stays
 * free of direct DB coupling; the route wires in the concrete query.
 */
export type CidReferenceChecker = (cid: string) => Promise<boolean>;

export async function isCidReferenced(
  cid: string,
  checker: CidReferenceChecker,
): Promise<boolean> {
  if (!cid) return false;
  return checker(cid);
}

export async function resolveUrl(cid: string): Promise<string> {
  return new URL(cid, `${env.IPFS_GATEWAY.replace(/\/$/, '')}/`).toString();
}