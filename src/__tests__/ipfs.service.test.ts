import { pinBundle, pinFile, resolveUrl } from '../services/ipfs';

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
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(new TypeError('fetch failed'));

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

  it('adds a bundle wrapped in a directory and parses the NDJSON response', async () => {
    const ndjson = [
      JSON.stringify({ Name: 'avatar.png', Hash: 'bafyAvatar', Size: '3' }),
      JSON.stringify({ Name: 'cv.pdf', Hash: 'bafyCv', Size: '4' }),
      JSON.stringify({ Name: 'manifest.json', Hash: 'bafyManifest', Size: '5' }),
      JSON.stringify({ Name: '', Hash: 'bafyRoot', Size: '12' }),
    ].join('\n');

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      text: async () => ndjson,
    } as Response);

    const result = await pinBundle([
      { path: 'avatar.png', content: Buffer.from('abc') },
      { path: 'cv.pdf', content: Buffer.from('abcd') },
      { path: 'manifest.json', content: Buffer.from('{}') },
    ]);

    expect(result).toEqual({
      rootCid: 'bafyRoot',
      files: {
        'avatar.png': 'bafyAvatar',
        'cv.pdf': 'bafyCv',
        'manifest.json': 'bafyManifest',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v0/add');
    expect(url.searchParams.get('wrap-with-directory')).toBe('true');
    expect(url.searchParams.get('pin')).toBe('true');
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal) });

    const body = init.body as FormData;
    const paths = Array.from(body.keys()).sort();
    expect(paths).toEqual(['avatar.png', 'cv.pdf', 'manifest.json']);
  });

  it('uses stable paths for bundle entries', async () => {
    const ndjson = [
      JSON.stringify({ Name: 'manifest.json', Hash: 'bafyManifest', Size: '2' }),
      JSON.stringify({ Name: '', Hash: 'bafyRoot', Size: '2' }),
    ].join('\n');

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      text: async () => ndjson,
    } as Response);

    await pinBundle([{ path: 'manifest.json', content: Buffer.from('{}') }]);

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = init.body as FormData;
    const entry = body.get('manifest.json') as File;
    expect(entry).toBeDefined();
    expect(entry.name).toBe('manifest.json');
  });

  it('fails when the bundle response has no root CID', async () => {
    const ndjson = [JSON.stringify({ Name: 'avatar.png', Hash: 'bafyAvatar', Size: '3' })].join('\n');

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      text: async () => ndjson,
    } as Response);

    await expect(pinBundle([{ path: 'avatar.png', content: Buffer.from('abc') }])).rejects.toThrow(/CID/);
  });

  it('maps bundle timeouts to 504 and unreachable nodes to 502', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(pinBundle([{ path: 'a.png', content: Buffer.from('d') }])).rejects.toMatchObject({
      statusCode: 504,
      expose: true,
    });
    await expect(pinBundle([{ path: 'a.png', content: Buffer.from('d') }])).rejects.toMatchObject({
      statusCode: 502,
      expose: true,
    });
  });

  it('fails when the bundle add returns an error status', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as Response);

    await expect(pinBundle([{ path: 'a.png', content: Buffer.from('d') }])).rejects.toMatchObject({
      statusCode: 502,
      message: 'IPFS add failed with status 503',
    });
  });
});
