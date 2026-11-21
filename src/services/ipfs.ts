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

/** CIDv0 (base58btc, sha2-256) or CIDv1 (multibase base32, sha2-256). */
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^b[a-z2-7]{58}$/;

export class IpfsUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpfsUriError';
  }
}

/**
 * Normalise an IPFS reference from chain data into `{ cid, path }`.
 * Accepts `ipfs://<cid>`, `ipfs://<cid>/<path>` and bare CIDv0/v1. Anything
 * else (notably `http(s)://` URIs) is rejected so chain data can never point
 * the gateway at an arbitrary host.
 */
export function parseIpfsUri(uri: string): { cid: string; path: string } {
  const trimmed = uri.trim();
  if (trimmed === '') throw new IpfsUriError('Empty IPFS URI');

  let rest = trimmed;
  if (/^ipfs:\/\//i.test(rest)) {
    rest = rest.slice('ipfs://'.length);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(rest)) {
    throw new IpfsUriError(`Unsupported URI scheme: ${trimmed}`);
  }

  const slash = rest.indexOf('/');
  const cid = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash + 1);

  if (!CID_V0.test(cid) && !CID_V1.test(cid)) {
    throw new IpfsUriError(`Invalid IPFS CID: ${cid}`);
  }
  if (path.split('/').some((segment) => segment === '..')) {
    throw new IpfsUriError('IPFS path must not contain ".."');
  }

  return { cid, path };
}

/** Gateway URL for an IPFS reference from chain data. */
export function resolveIpfsUri(uri: string): string {
  const { cid, path } = parseIpfsUri(uri);
  return resolveUrl(path === '' ? cid : `${cid}/${path}`);
}

export function resolveUrl(cid: string): string {
  return new URL(cid, `${env.IPFS_GATEWAY.replace(/\/$/, '')}/`).toString();
}
