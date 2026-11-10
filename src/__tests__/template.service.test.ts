import * as templateService from '../services/template';
import pool from '../db/client';

jest.mock('../db/client', () => ({ query: jest.fn() }));
const mockQuery = pool.query as jest.Mock;

describe('template service', () => {
  afterEach(() => jest.clearAllMocks());

  it('lists templates in id order', async () => {
    const registeredAt = new Date();
    mockQuery.mockResolvedValue({
      rows: [{ id: '1', metadata_uri: 'ipfs://bafy', creator: 'GADMIN', registered_at: registeredAt }],
    });

    const result = await templateService.listTemplates();

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM templates ORDER BY id'));
    expect(result).toEqual([{ id: 1, metadataUri: 'ipfs://bafy', creator: 'GADMIN', registeredAt }]);
  });

  it('returns null when template is missing', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(templateService.getTemplate(9)).resolves.toBeNull();
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), [9]);
  });
});
