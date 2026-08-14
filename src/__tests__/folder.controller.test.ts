import { getByAddress, getByName, getCredentials } from '../controllers/folder.controller';
import * as folderService from '../services/folder';
import { invokeHandler, mockResponse } from './testUtils';

jest.mock('../services/folder');

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
      name: 'alice',
      cid: 'QmCid',
      templateId: 1,
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

  it('returns credentials for a valid address', async () => {
    const credentials = [{ owner: validAddress, platform: 'github', proofHash: 'proof', linkedAt: new Date() }];
    mockFolderService.getCredentials.mockResolvedValue(credentials);
    const res = mockResponse();

    const { next } = await invokeHandler(getCredentials, { params: { address: validAddress } }, res);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(credentials);
  });
});
