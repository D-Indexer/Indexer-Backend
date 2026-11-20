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

export interface BundleFile {
  /** Stable path within the directory, e.g. `manifest.json` or `assets/avatar.png`. */
  path: string;
  buffer: Buffer;
}

export interface BundleResult {
  /** Root CID of the wrapped directory; this is the reference unit for GC/reconciliation. */
  rootCid: string;
  /** Map of stable path -> CID for each file in the bundle. */
  files: Record<string, string>;
}

interface KuboAddEntry {
  Name?: string;
  Hash?: string;
  Size?: string;
}

/**
 * Parse Kubo's NDJSON add response. Each line is a JSON object; the last line
 * for a `wrap-with-directory=true` add is the directory entry (empty Name).
 */
export function parseAddResponse(ndjson: string): KuboAddEntry[] {
  const entries: KuboAddEntry[] = [];
  for (const rawLine of ndjson.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as KuboAddEntry);
    } catch {
      throw new HttpError(502, 'IPFS add response was not valid NDJSON', true);
    }
  }
  return entries;
}

/**
 * Add a bundle of files as a single wrapped directory and pin the root.
 * Returns the root CID (the reference unit) plus per-path CIDs.
 */
export async function pinBundle(files: BundleFile[]): Promise<BundleResult> {
  if (files.length === 0) {
    throw new HttpError(400, 'Bundle must contain at least one file');
  }

  const formData = new FormData();
  for (const file of files) {
    // Kubo uses the multipart filename as the path within the directory.
    formData.append('file', new Blob([file.buffer]), file.path);
  }

  const addUrl = new URL('/api/v0/add', env.IPFS_API_URL);
  addUrl.searchParams.set('pin', 'true');
  addUrl.searchParams.set('cid-version', '1');
  addUrl.searchParams.set('wrap-with-directory', 'true');

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

  const text = await addResponse.text();
  const entries = parseAddResponse(text);

  const filesByPath: Record<string, string> = {};
  let rootCid: string | undefined;

  for (const entry of entries) {
    if (!entry.Hash) continue;
    if (!entry.Name) {
      // Directory entry produced by wrap-with-directory.
      rootCid = entry.Hash;
    } else {
      filesByPath[entry.Name] = entry.Hash;
    }
  }

  if (!rootCid) {
    throw new HttpError(502, 'IPFS add response did not include a root CID', true);
  }

  return { rootCid, files: filesByPath };
}

export async function resolveUrl(cid: string): Promise<string> {
  return new URL(cid, `${env.IPFS_GATEWAY.replace(/\/$/, '')}/`).toString();
}