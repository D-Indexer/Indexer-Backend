import { pinFile, resolveUrl } from '../services/ipfs';

describe('ipfs service', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves gateway urls without duplicate slashes', async () => {
    await expect(resolveUrl('bafy123')).resolves.toBe('https://ipfs.io/ipfs/bafy123');
  });

  it('adds and pins files through Kubo RPC', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Hash: 'bafyAdded' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
      } as Response);

    await expect(pinFile(Buffer.from('data'), 'profile.png')).resolves.toBe('bafyAdded');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL('/api/v0/add', 'http://localhost:5001'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pathname: '/api/v0/pin/add' }),
      { method: 'POST' }
    );
  });

  it('fails when Kubo does not return a CID', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    await expect(pinFile(Buffer.from('data'), 'profile.png')).rejects.toThrow(/CID/);
  });

  it('fails when Kubo add returns an error status', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as Response);

    await expect(pinFile(Buffer.from('data'), 'profile.png')).rejects.toThrow(/IPFS add failed/);
  });
});
