import { getEnv } from '../config/env';
import { HttpError } from '../http/errors';

const env = getEnv();

/**
 * Build the headers for a Kubo RPC request, including the bearer token when
 * `IPFS_API_AUTH` is configured. Kubo's `API.Authorizations` (>= 0.25) expects
 * `Authorization: Bearer <token>` on every RPC call.
 */
function rpcHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (env.IPFS_API_AUTH) {
    headers.Authorization = `Bearer ${env.IPFS_API_AUTH}`;
  }
  return headers;
}

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
      headers: rpcHeaders(),
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

export async function resolveUrl(cid: string): Promise<string> {
  return new URL(cid, `${env.IPFS_GATEWAY.replace(/\/$/, '')}/`).toString();
}

/**
 * Probe the Kubo RPC without credentials and warn if it is accepted. This lets
 * operators know when the node is reachable unauthenticated (e.g. a shared
 * network or a misconfigured `API.Authorizations`). Safe to call at startup;
 * never throws.
 */
export async function checkKuboAuth(): Promise<void> {
  const versionUrl = new URL('/api/v0/version', env.IPFS_API_URL);
  try {
    const response = await fetch(versionUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(env.IPFS_TIMEOUT_MS),
    });
    if (response.ok) {
      console.warn(
        '[ipfs] Kubo RPC accepted an unauthenticated request to /api/v0/version. ' +
          'Restrict network access to the API and configure API.Authorizations ' +
          '(IPFS_API_AUTH) so only authenticated callers can reach the node.',
      );
    }
  } catch {
    // Unreachable or timed out: nothing to warn about here; uploads will
    // surface connectivity problems with their own errors.
  }
}