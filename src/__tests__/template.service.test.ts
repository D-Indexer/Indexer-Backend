import * as templateService from '../services/template';
import pool from '../db/client';

jest.mock('../db/client', () => ({ query: jest.fn() }));
const mockQuery = pool.query as jest.Mock;

describe('template service', () => {
  afterEach(() => jest.clearAllMocks());

  it('lists active templates in id order', async () => {
    const createdAt = new Date();
    mockQuery.mockResolvedValue({
      rows: [{ id: 1, metadata_cid: 'QmTemplate', deprecated: false, created_at: createdAt }],
    });

    const result = await templateService.listTemplates();

    expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM templates WHERE deprecated = FALSE ORDER BY id');
    expect(result).toEqual([{ id: 1, metadataCid: 'QmTemplate', deprecated: false, createdAt }]);
  });

  it('returns null when template is missing', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(templateService.getTemplate(9)).resolves.toBeNull();
  });
});
