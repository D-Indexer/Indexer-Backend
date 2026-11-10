import * as folderService from '../services/folder';
import * as portfolioService from '../services/portfolio';
import pool from '../db/client';

jest.mock('../db/client', () => ({ query: jest.fn() }));
const mockQuery = pool.query as jest.Mock;

const at = new Date('2026-11-09T22:17:47Z');

describe('folder service', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns null when no row found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(folderService.getFolderByAddress('GABC')).resolves.toBeNull();
  });

  it('maps snake_case columns, converting BIGINT template ids', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ owner: 'GABC', name: 'alice.folder', template_id: '1', claimed_at: at, updated_at: at }],
    });

    await expect(folderService.getFolderByAddress('GABC')).resolves.toEqual({
      owner: 'GABC',
      name: 'alice.folder',
      templateId: 1,
      claimedAt: at,
      updatedAt: at,
    });
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE owner = $1'), ['GABC']);
  });

  it('keeps a null template id for folders without a selected template', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ owner: 'GABC', name: 'alice.folder', template_id: null, claimed_at: at, updated_at: at }],
    });

    const result = await folderService.getFolderByName('alice.folder');

    expect(result?.templateId).toBeNull();
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE name = $1'), ['alice.folder']);
  });
});

describe('portfolio service', () => {
  afterEach(() => jest.clearAllMocks());

  it('maps a portfolio row', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ owner: 'GABC', template_id: '2', ipfs_cid: 'bafy', minted_at: at, updated_at: at }],
    });

    await expect(portfolioService.getPortfolio('GABC')).resolves.toEqual({
      owner: 'GABC',
      templateId: 2,
      ipfsCid: 'bafy',
      mintedAt: at,
      updatedAt: at,
    });
  });

  it('returns null when the owner has not minted', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(portfolioService.getPortfolio('GABC')).resolves.toBeNull();
  });
});
