import { Request, Response } from 'express';
import { upload } from '../controllers/upload.controller';
import { invokeHandler, mockResponse } from './testUtils';
import { pinFile } from '../services/ipfs';

jest.mock('../services/ipfs', () => ({
  pinFile: jest.fn(),
}));

const mockPin = pinFile as jest.Mock;

describe('upload controller', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns 400 when no file attached', async () => {
    const req = {} as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(upload, req, res);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(mockPin).not.toHaveBeenCalled();
  });

  it('returns cid on successful upload', async () => {
    mockPin.mockResolvedValue('QmTestCID');
    const req = {
      file: { buffer: Buffer.from('data'), originalname: 'test.png', mimetype: 'image/png', size: 100 },
    } as unknown as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(upload, req, res);

    expect(next).not.toHaveBeenCalled();
    expect(mockPin).toHaveBeenCalledWith(Buffer.from('data'), 'test.png');
    expect(res.json).toHaveBeenCalledWith({ cid: 'QmTestCID' });
  });

  it('rejects unsupported file types', async () => {
    const req = {
      file: { buffer: Buffer.from('data'), originalname: 'test.exe', mimetype: 'application/x-msdownload', size: 100 },
    } as unknown as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(upload, req, res);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(mockPin).not.toHaveBeenCalled();
  });
});
