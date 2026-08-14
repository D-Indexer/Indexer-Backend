import { getEnv } from '../config/env';

const env = getEnv();

export async function pinFile(buffer: Buffer, filename: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', new Blob([buffer]), filename);

  const addUrl = new URL('/api/v0/add', env.IPFS_API_URL);
  const addResponse = await fetch(addUrl, {
    method: 'POST',
    body: formData,
  });

  if (!addResponse.ok) {
    throw new Error(`IPFS add failed with status ${addResponse.status}`);
  }

  const addResult = (await addResponse.json()) as { Hash?: string };
  if (!addResult.Hash) {
    throw new Error('IPFS add response did not include a CID');
  }

  const pinUrl = new URL('/api/v0/pin/add', env.IPFS_API_URL);
  pinUrl.searchParams.set('arg', addResult.Hash);

  const pinResponse = await fetch(pinUrl, { method: 'POST' });
  if (!pinResponse.ok) {
    throw new Error(`IPFS pin failed with status ${pinResponse.status}`);
  }

  return addResult.Hash;
}

export async function resolveUrl(cid: string): Promise<string> {
  return new URL(cid, `${env.IPFS_GATEWAY.replace(/\/$/, '')}/`).toString();
}
