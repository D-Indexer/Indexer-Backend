import { HttpError } from '../http/errors';
import { getContext, recordTiming } from '../utils/context';

export interface IpfsServiceDeps {
  apiUrl: string;
  gateway: string;
  timeoutMs: number;
}

export interface IpfsService {
  pinFile(buffer: Buffer, filename: string): Promise<string>;
  resolveUrl(cid: string): Promise<string>;
}

export function createIpfsService(deps: IpfsServiceDeps): IpfsService {
  const { apiUrl, gateway, timeoutMs } = deps;

  /**
   * Add a file to the configured Kubo node and pin it (`pin=true` is explicit so
   * no separate pin call is needed). Upstream failures surface as 502/504.
   */
  async function pinFile(buffer: Buffer, filename: string): Promise<string> {
    const formData = new FormData();
    formData.append('file', new Blob([buffer]), filename);

    const addUrl = new URL('/api/v0/add', apiUrl);
    addUrl.searchParams.set('pin', 'true');
    addUrl.searchParams.set('cid-version', '1');

    let addResponse: Response;
    try {
      addResponse = await fetch(addUrl, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(timeoutMs),
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

  async function resolveUrl(cid: string): Promise<string> {
    return new URL(cid, `${gateway.replace(/\/$/, '')}/`).toString();
  }

  return { pinFile, resolveUrl };
}

/**
 * Probe the Kubo node (`/api/v0/version`) for readiness checks. Resolves when
 * the node answers 2xx, rejects otherwise; never throws an HttpError.
 */
export async function checkKuboReachable(timeoutMs: number): Promise<void> {
  const versionUrl = new URL('/api/v0/version', env.IPFS_API_URL);
  const response = await fetch(versionUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Kubo version check failed with status ${response.status}`);
  }
}
