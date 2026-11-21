import { getEnv } from '../config/env';
import { HttpError } from '../http/errors';
import { logger } from '../utils/logger';
import { createHash } from 'crypto';

const env = getEnv();

function base32Lower(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function cidV1RawSha256(buffer: Buffer): string {
  const digest = createHash('sha256').update(buffer).digest();
  const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  return `b${base32Lower(cidBytes)}`;
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
  addUrl.searchParams.set('raw-leaves', 'true');
  addUrl.searchParams.set('hash', 'sha2-256');
  addUrl.searchParams.set('chunker', 'size-262144');

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

  if (env.IPFS_VERIFY_CID && buffer.byteLength <= 262144) {
    const expectedCid = cidV1RawSha256(buffer);
    if (addResult.Hash !== expectedCid) {
      logger.error('IPFS CID mismatch', { expectedCid, returnedCid: addResult.Hash });
      throw new HttpError(502, 'IPFS add returned a CID that does not match the uploaded bytes', true);
    }
  }

  return addResult.Hash;
}

export async function resolveUrl(cid: string): Promise<string> {
  return new URL(cid, `${env.IPFS_GATEWAY.replace(/\/$/, '')}/`).toString();
}
