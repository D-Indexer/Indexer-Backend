import { reconcileCid } from '../ipfs/reconcile';

describe('IPFS reconciler', () => {
  it.each([['pinned', { Keys: { QmPinned: {} } }, 'pinned']])(
    '%s CID needs no repinning',
    async (_name, body, expected) => {
      const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
      } as Response);

      await expect(reconcileCid(db, 'QmPinned', fetchMock as unknown as typeof fetch)).resolves.toBe(
        expected
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('repins a missing CID', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ Keys: {} }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await expect(reconcileCid(db, 'QmMissing', fetchMock as unknown as typeof fetch)).resolves.toBe('pinned');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records unavailable CIDs and does not throw', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    await expect(reconcileCid(db, 'QmUnavailable', fetchMock as unknown as typeof fetch)).resolves.toBe(
      'unavailable'
    );
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("'unavailable'"), [
      'QmUnavailable',
      'pin ls failed with status 503',
    ]);
  });
});
