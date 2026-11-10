import * as adminService from '../services/admin';
import pool from '../db/client';

jest.mock('../db/client', () => ({ query: jest.fn() }));
const mockQuery = pool.query as jest.Mock;

const at = new Date('2026-11-09T22:14:42Z');

describe('admin service', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns empty array when no admins found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(adminService.listAdmins()).resolves.toEqual([]);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT address, added_at FROM admins ORDER BY added_at ASC, address ASC'
    );
  });

  it('maps admin rows and orders by added_at, then address', async () => {
    const admin1 = { address: 'GADMIN1', added_at: at };
    const admin2 = { address: 'GADMIN2', added_at: new Date('2026-11-10T08:00:00Z') };
    mockQuery.mockResolvedValue({ rows: [admin1, admin2] });

    await expect(adminService.listAdmins()).resolves.toEqual([
      { address: 'GADMIN1', addedAt: at },
      { address: 'GADMIN2', addedAt: admin2.added_at },
    ]);
  });
});
