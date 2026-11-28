import { pinFile, resolveUrl } from '../services/ipfs';
import { runWithContext, getContext } from '../utils/context';

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

  it('sends the Authorization header when IPFS_API_AUTH is configured', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Hash: 'bafyAuthed' }),
    } as Response);

    await expect(pinFile(Buffer.from('data'), 'profile.png')).resolves.toBe('bafyAuthed');

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer test-secret');
  });

  it('omits the Authorization header when IPFS_API_AUTH is unset', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Hash: 'bafyAnon' }),
    } as Response);

    await expect(pinFile(Buffer.from('data'), 'profile.png')).resolves.toBe('bafyAnon');

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has('authorization')).toBe(false);
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

  it('propagates the current request id to outbound Kubo calls', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Hash: 'bafyAdded' }),
    } as Response);

    await runWithContext({ requestId: 'req-abc-123' }, () =>
      pinFile(Buffer.from('data'), 'profile.png'),
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('x-request-id')).toBe('req-abc-123');
  });

  it('records the Kubo call duration in the request context', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Hash: 'bafyAdded' }),
    } as Response);

    const timings = await runWithContext({ requestId: 'req-timing' }, async () => {
      await pinFile(Buffer.from('data'), 'profile.png');
      return getContext()?.timings;
    });

    expect(timings).toBeDefined();
    expect(timings?.ipfs?.count).toBe(1);
    expect(typeof timings?.ipfs?.durationMs).toBe('number');
    expect(timings?.ipfs?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
