import { getByAddress, getByName } from '../controllers/folder.controller';
import * as portfolioController from '../controllers/portfolio.controller';
import * as portfolioService from '../services/portfolio';
import * as folderService from '../services/folder';
import { invokeHandler, mockResponse } from './testUtils';

jest.mock('../services/folder');
jest.mock('../services/portfolio');

const mockFolderService = folderService as jest.Mocked<typeof folderService>;
const validAddress = `G${'A'.repeat(55)}`;

describe('folder controller', () => {
  afterEach(() => jest.clearAllMocks());

  it('rejects invalid Stellar addresses', async () => {
    const { next } = await invokeHandler(getByAddress, { params: { address: 'bad' } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns a folder by address', async () => {
    const folder = {
      owner: validAddress,
      name: 'alice.folder',
      templateId: 1,
      claimedAt: new Date(),
      updatedAt: new Date(),
    };
    mockFolderService.getFolderByAddress.mockResolvedValue(folder);
    const res = mockResponse();

    const { next } = await invokeHandler(getByAddress, { params: { address: validAddress } }, res);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(folder);
  });

  it('returns not found when folder is missing', async () => {
    mockFolderService.getFolderByAddress.mockResolvedValue(null);

    const { next } = await invokeHandler(getByAddress, { params: { address: validAddress } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('validates folder names', async () => {
    const { next } = await invokeHandler(getByName, { params: { name: 'bad name' } });

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('accepts contract (C...) owner addresses', async () => {
    mockFolderService.getFolderByAddress.mockResolvedValue(null);
    const contractAddress = `C${'A'.repeat(55)}`;

    await invokeHandler(getByAddress, { params: { address: contractAddress } });

    expect(mockFolderService.getFolderByAddress).toHaveBeenCalledWith(contractAddress);
  });
});

describe('portfolio controller', () => {
  const mockPortfolioService = portfolioService as jest.Mocked<typeof portfolioService>;
  afterEach(() => jest.clearAllMocks());

  it('rejects invalid addresses', async () => {
    const { next } = await invokeHandler(portfolioController.getByAddress, { params: { address: 'nope' } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns the portfolio', async () => {
    const portfolio = {
      owner: validAddress,
      templateId: 1,
      ipfsCid: 'bafy',
      mintedAt: new Date(),
      updatedAt: new Date(),
    };
    mockPortfolioService.getPortfolio.mockResolvedValue(portfolio);
    const res = mockResponse();

    await invokeHandler(portfolioController.getByAddress, { params: { address: validAddress } }, res);

    expect(res.json).toHaveBeenCalledWith(portfolio);
  });

  it('returns not found when nothing is minted', async () => {
    mockPortfolioService.getPortfolio.mockResolvedValue(null);
    const { next } = await invokeHandler(portfolioController.getByAddress, {
      params: { address: validAddress },
    });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});
