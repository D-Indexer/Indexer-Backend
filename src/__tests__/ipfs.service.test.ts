import { resolveUrl } from '../services/ipfs';

describe('ipfs service', () => {
  it('resolves gateway urls without duplicate slashes', async () => {
    await expect(resolveUrl('bafy123')).resolves.toBe('https://ipfs.io/ipfs/bafy123');
  });
});
