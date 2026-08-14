import * as folderService from '../services/folder';
import pool from '../db/client';

jest.mock('../db/client', () => ({ query: jest.fn() }));
const mockQuery = pool.query as jest.Mock;

describe('folderService', () => {
  afterEach(() => jest.clearAllMocks());

  describe('getFolderByAddress', () => {
    it('returns null when no row found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const result = await folderService.getFolderByAddress('GABC');
      expect(result).toBeNull();
    });

    it('maps snake_case columns to camelCase', async () => {
      const updatedAt = new Date();
      mockQuery.mockResolvedValue({
        rows: [{ owner: 'GABC', name: 'alice', cid: 'Qm1', template_id: 1, updated_at: updatedAt }],
      });

      const result = await folderService.getFolderByAddress('GABC');

      expect(result).toEqual({
        owner: 'GABC',
        name: 'alice',
        cid: 'Qm1',
        templateId: 1,
        updatedAt,
      });
    });

    it('queries by owner using a parameterized query', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await folderService.getFolderByAddress('GABC');

      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM folders WHERE owner = $1', ['GABC']);
    });
  });

  describe('getFolderByName', () => {
    it('maps rows from name lookup', async () => {
      const updatedAt = new Date();
      mockQuery.mockResolvedValue({
        rows: [{ owner: 'GABC', name: 'alice', cid: 'Qm1', template_id: 3, updated_at: updatedAt }],
      });

      const result = await folderService.getFolderByName('alice');

      expect(result?.templateId).toBe(3);
      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM folders WHERE name = $1', ['alice']);
    });
  });

  describe('getCredentials', () => {
    it('returns empty array when no credentials', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const result = await folderService.getCredentials('GABC');
      expect(result).toEqual([]);
    });

    it('maps credential rows to camelCase', async () => {
      const linkedAt = new Date();
      mockQuery.mockResolvedValue({
        rows: [{ owner: 'GABC', platform: 'github', proof_hash: 'abc123', linked_at: linkedAt }],
      });

      const result = await folderService.getCredentials('GABC');

      expect(result).toEqual([
        { owner: 'GABC', platform: 'github', proofHash: 'abc123', linkedAt },
      ]);
    });
  });
});
