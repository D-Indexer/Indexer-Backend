import { runGc } from '../ipfs/gc';

describe('IPFS garbage collection', () => {
  it('dry-runs unreferenced old uploads', async () => {
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ cid: 'QmOld' }] })
        .mockResolvedValue({ rows: [] }),
    };
    await expect(runGc(db, { olderThanDays: 7, dryRun: true })).resolves.toEqual({
      eligible: 1,
      unpinned: 0,
      dryRun: 1,
    });
  });

  it('never removes a CID referenced on-chain', async () => {
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ cid: 'QmReferenced' }] })
        .mockResolvedValueOnce({ rows: [{ cid: 'QmReferenced' }] })
        .mockResolvedValue({ rows: [] }),
    };
    await expect(runGc(db, { olderThanDays: 7 })).resolves.toEqual({
      eligible: 0,
      unpinned: 0,
      dryRun: 0,
    });
  });
});
