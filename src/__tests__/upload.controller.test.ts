import { Request } from 'express';
import { upload } from '../controllers/upload.controller';
import { invokeHandler, mockResponse } from './testUtils';
import { pinFile } from '../services/ipfs';
import { sniffContentType } from '../validation/fileType';

jest.mock('../services/ipfs', () => ({
  pinFile: jest.fn(),
}));

const mockPin = pinFile as jest.Mock;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

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
      file: { buffer: PNG, originalname: 'test.png', mimetype: 'image/png', size: 100 },
    } as unknown as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(upload, req, res);

    expect(next).not.toHaveBeenCalled();
    expect(mockPin).toHaveBeenCalledWith(PNG, 'test.png');
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

  it('rejects files whose bytes do not match the declared type', async () => {
    const req = {
      file: { buffer: Buffer.from('MZ\x90\x00'), originalname: 'evil.png', mimetype: 'image/png', size: 4 },
    } as unknown as Request;

    const { next } = await invokeHandler(upload, req);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'File content does not match its declared type' })
    );
    expect(mockPin).not.toHaveBeenCalled();
  });
});

describe('sniffContentType', () => {
  it.each([
    [[0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
    [[...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')], 'image/webp'],
    [[...Buffer.from('%PDF-1.7')], 'application/pdf'],
    [[...Buffer.from('<svg>')], null],
    [[], null],
  ])('detects %#', (bytes, expected) => {
    expect(sniffContentType(Buffer.from(bytes as number[]))).toBe(expected);
  });
});
