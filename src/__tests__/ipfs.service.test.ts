import { createHash } from 'crypto';
import {
  isCidDenylisted,
  pinFile,
  resolveUrl,
  sanitiseFilename,
  unpinCid,
} from '../services/ipfs';

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

  describe('sanitiseFilename', () => {
    it('strips path separators and traversal sequences', () => {
      expect(sanitiseFilename('../../a')).not.toMatch(/[\\/]/);
      expect(sanitiseFilename('../../a')).not.toContain('..');
      expect(sanitiseFilename('dir/sub/file.png')).not.toMatch(/[\\/]/);
      expect(sanitiseFilename('..\\..\\windows.png')).not.toMatch(/[\\/]/);
    });

    it('removes NUL, CR and LF control characters', () => {
      const result = sanitiseFilename('a\u0000b\rc\nd.png');
      expect(result).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(result).toMatch(/^[A-Za-z0-9._-]+$/);
    });

    it('removes RTL override and other unicode tricks', () => {
      const result = sanitiseFilename('\u202Egnp.exe');
      expect(result).not.toContain('\u202E');
      expect(result).toMatch(/^[A-Za-z0-9._-]+$/);
    });

    it('limits names to 100 characters', () => {
      const result = sanitiseFilename('a'.repeat(1000) + '.png');
      expect(result.length).toBeLessThanOrEqual(100);
      expect(result).toMatch(/^[A-Za-z0-9._-]+$/);
    });

    it('falls back to a server-chosen name when nothing usable remains', () => {
      expect(sanitiseFilename('')).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(sanitiseFilename('...')).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(sanitiseFilename('\u0000\u0001')).toMatch(/^[A-Za-z0-9._-]+$/);
    });

    it('keeps safe names intact', () => {
      expect(sanitiseFilename('profile.png')).toBe('profile.png');
    });
  });

  describe('denylist enforcement', () => {
    const cid = 'bafyDenied';
    const hashed = createHash('sha256').update(cid).digest('hex');

    it('matches a plain CID entry', () => {
      expect(isCidDenylisted(cid, [cid])).toBe(true);
      expect(isCidDenylisted('bafyOther', [cid])).toBe(false);
    });

    it('matches a sha256(CID) double-hash entry', () => {
      expect(isCidDenylisted(cid, [hashed])).toBe(true);
      expect(isCidDenylisted(cid, [`sha256:${hashed}`])).toBe(true);
      expect(isCidDenylisted('bafyOther', [hashed])).toBe(false);
    });

    it('rejects re-upload of a denylisted CID before calling Kubo', async () => {
      const fetchMock = jest.spyOn(global, 'fetch');

      await expect(pinFile(Buffer.from('data'), 'profile.png', { denylist: [cid] })).rejects.toMatchObject({
        statusCode: 451,
        expose: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('unpins a CID via Kubo RPC', async () => {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

      await expect(unpinCid(cid)).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.pathname).toBe('/api/v0/pin/rm');
      expect(url.searchParams.get('arg')).toBe(cid);
      expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal) });
    });

    it('treats an already-unpinned CID as success', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'not pinned',
      } as Response);

      await expect(unpinCid(cid)).resolves.toBeUndefined();
    });
  });
});
