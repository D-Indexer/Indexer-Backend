import { pinFile, resolveUrl } from '../services/ipfs';

describe('ipfs service', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves gateway urls without duplicate slashes', async () => {
    await expect(resolveUrl('bafy123')).resolves.toBe('https://ipfs.io/ipfs/bafy123');
  });

  it('adds and pins files in one Kubo RPC call with a timeout', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Hash: 'bafyAdded' }),
    } as Response);

    await expect(pinFile(Buffer.from('data'), 'profile.png')).resolves.toBe('bafyAdded');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v0/add');
    expect(url.searchParams.get('pin')).toBe('true');
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal) });
  });

  it('maps a timeout to 504 and an unreachable node to 502', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(timeout).mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(pinFile(Buffer.from('d'), 'a.png')).rejects.toMatchObject({ statusCode: 504, expose: true });
    await expect(pinFile(Buffer.from('d'), 'a.png')).rejects.toMatchObject({ statusCode: 502, expose: true });
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

    await expect(pinFile(Buffer.from('data'), 'profile.png')).rejects.toMatchObject({
      statusCode: 502,
      message: 'IPFS add failed with status 503',
    });
  });
});
