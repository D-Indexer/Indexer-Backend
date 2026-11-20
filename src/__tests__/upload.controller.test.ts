import { Request } from 'express';
import { upload } from '../controllers/upload.controller';
import { invokeHandler, mockResponse } from './testUtils';
import { pinFile } from '../services/ipfs';
import { sniffContentType } from '../validation/fileType';
import { sanitiseFilename } from '../services/filename';
import {
  createResumableUpload,
  patchResumableUpload,
  headResumableUpload,
  completeResumableUpload,
} from '../services/resumableUpload';
import { isCidDenylisted } from '../services/cidDenylist';

jest.mock('../services/ipfs', () => ({
  pinFile: jest.fn(),
}));

jest.mock('../services/resumableUpload', () => ({
  createResumableUpload: jest.fn(),
  patchResumableUpload: jest.fn(),
  headResumableUpload: jest.fn(),
  completeResumableUpload: jest.fn(),
}));

jest.mock('../services/cidDenylist', () => ({
  isCidDenylisted: jest.fn(),
}));

const mockPin = pinFile as jest.Mock;
const mockCreate = createResumableUpload as jest.Mock;
const mockPatch = patchResumableUpload as jest.Mock;
const mockHead = headResumableUpload as jest.Mock;
const mockComplete = completeResumableUpload as jest.Mock;
const mockDenylisted = isCidDenylisted as jest.Mock;
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

  it.each([
    ['../../a', 'upload.png'],
    ['evil\u0000name.png', 'upload.png'],
    ['evil\r\nname.png', 'upload.png'],
    ['a'.repeat(1000) + '.png', 'upload.png'],
    ['..\\..\\windows.png', 'upload.png'],
    ['\u202Egnp.exe', 'upload.png'],
  ])('passes a sanitised filename to pinFile for %j', async (originalname, expected) => {
    mockPin.mockResolvedValue('QmTestCID');
    const req = {
      file: { buffer: PNG, originalname, mimetype: 'image/png', size: PNG.length },
    } as unknown as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(upload, req, res);

    expect(next).not.toHaveBeenCalled();
    const passedName = mockPin.mock.calls[0][1] as string;
    expect(passedName).toBe(expected);
    expect(passedName).toMatch(/^[A-Za-z0-9._-]{1,100}$/);
    expect(passedName).not.toContain('/');
    expect(passedName).not.toContain('\\');
    expect(passedName).not.toMatch(/[\u0000-\u001f\u202a-\u202e]/);
  });

  it('rejects re-upload of denylisted content', async () => {
    mockDenylisted.mockResolvedValue(true);
    const req = {
      file: { buffer: PNG, originalname: 'test.png', mimetype: 'image/png', size: PNG.length },
    } as unknown as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(upload, req, res);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 451 }));
    expect(mockPin).not.toHaveBeenCalled();
  });

  it('flags contentRemoved when the pinned CID is denylisted', async () => {
    mockDenylisted.mockResolvedValue(false);
    mockPin.mockResolvedValue('QmTestCID');
    const req = {
      file: { buffer: PNG, originalname: 'test.png', mimetype: 'image/png', size: PNG.length },
    } as unknown as Request;
    const res = mockResponse();

    await invokeHandler(upload, req, res);

    expect(res.json).toHaveBeenCalledWith({ cid: 'QmTestCID', contentRemoved: false });
  });

  it('rejects unsupported file types', async () => {
    const req = {
      file: {
        buffer: Buffer.from('data'),
        originalname: 'test.exe',
        mimetype: 'application/x-msdownload',
        size: 100,
      },
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

describe('sanitiseFilename', () => {
  it.each([
    ['../../a', 'upload'],
    ['a\u0000b', 'upload'],
    ['a\r\nb', 'upload'],
    ['a'.repeat(1000), 'upload'],
    ['\u202Eevil', 'upload'],
    ['photo.PNG', 'photo.PNG'],
    ['my-file_1.jpg', 'my-file_1.jpg'],
  ])('sanitises %j', (input, expected) => {
    const result = sanitiseFilename(input);
    expect(result).toBe(expected);
    expect(result).toMatch(/^[A-Za-z0-9._-]{1,100}$/);
  });

  it('never returns path separators or control characters', () => {
    const result = sanitiseFilename('..\\..\\a\u0000\r\n\u202E' + 'x'.repeat(2000));
    expect(result).not.toMatch(/[/\\\u0000-\u001f\u202a-\u202e]/);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});

describe('resumable upload protocol', () => {
  const CHUNK_A = PNG;
  const CHUNK_B = Buffer.from('second-half-of-file');
  const FULL = Buffer.concat([CHUNK_A, CHUNK_B]);
  const CID = 'QmResumableCID';

  afterEach(() => jest.clearAllMocks());

  it('creates an upload and returns an upload id', async () => {
    mockCreate.mockResolvedValue({ uploadId: 'up_1', offset: 0 });
    const req = {
      headers: { 'upload-length': String(FULL.length), 'upload-metadata': 'filename dGVzdC5wbmc=' },
    } as unknown as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(createResumableUpload, req, res);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.setHeader).toHaveBeenCalledWith('Location', expect.stringContaining('up_1'));
    expect(res.setHeader).toHaveBeenCalledWith('Upload-Offset', '0');
  });

  it('patches a chunk and reports the new offset', async () => {
    mockPatch.mockResolvedValue({ offset: CHUNK_A.length });
    const req = {
      params: { id: 'up_1' },
      headers: { 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
      body: CHUNK_A,
    } as unknown as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(patchResumableUpload, req, res);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.setHeader).toHaveBeenCalledWith('Upload-Offset', String(CHUNK_A.length));
  });

  it('rejects a patch whose offset does not match the stored offset', async () => {
    mockPatch.mockRejectedValue(
      Object.assign(new Error('Offset mismatch'), { statusCode: 409 })
    );
    const req = {
      params: { id: 'up_1' },
      headers: { 'upload-offset': '999', 'content-type': 'application/offset+octet-stream' },
      body: CHUNK_A,
    } as unknown as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(patchResumableUpload, req, res);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
  });

  it('heads an upload to report the stored offset after interruption', async () => {
    mockHead.mockResolvedValue({ offset: CHUNK_A.length, length: FULL.length });
    const req = { params: { id: 'up_1' } } as unknown as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(headResumableUpload, req, res);

    expect(next).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Upload-Offset', String(CHUNK_A.length));
    expect(res.setHeader).toHaveBeenCalledWith('Upload-Length', String(FULL.length));
  });

  it('resumes from the stored offset after an interruption at 60%', async () => {
    const cut = Math.floor(FULL.length * 0.6);
    const first = FULL.subarray(0, cut);
    const rest = FULL.subarray(cut);

    mockHead.mockResolvedValue({ offset: first.length, length: FULL.length });
    const headReq = { params: { id: 'up_1' } } as unknown as Request;
    const headRes = mockResponse();
    await invokeHandler(headResumableUpload, headReq, headRes);
    expect(headRes.setHeader).toHaveBeenCalledWith('Upload-Offset', String(first.length));

    mockPatch.mockResolvedValue({ offset: FULL.length });
    const patchReq = {
      params: { id: 'up_1' },
      headers: { 'upload-offset': String(first.length), 'content-type': 'application/offset+octet-stream' },
      body: rest,
    } as unknown as Request;
    const patchRes = mockResponse();
    await invokeHandler(patchResumableUpload, patchReq, patchRes);
    expect(patchRes.setHeader).toHaveBeenCalledWith('Upload-Offset', String(FULL.length));

    mockComplete.mockResolvedValue({ cid: CID });
    const completeReq = { params: { id: 'up_1' } } as unknown as Request;
    const completeRes = mockResponse();
    const { next } = await invokeHandler(completeResumableUpload, completeReq, completeRes);

    expect(next).not.toHaveBeenCalled();
    expect(completeRes.json).toHaveBeenCalledWith(expect.objectContaining({ cid: CID }));
  });

  it('produces the same CID as a single-request upload', async () => {
    mockPin.mockResolvedValue(CID);
    const singleReq = {
      file: { buffer: FULL, originalname: 'test.png', mimetype: 'image/png', size: FULL.length },
    } as unknown as Request;
    const singleRes = mockResponse();
    await invokeHandler(upload, singleReq, singleRes);
    expect(singleRes.json).toHaveBeenCalledWith(expect.objectContaining({ cid: CID }));

    mockComplete.mockResolvedValue({ cid: CID });
    const completeReq = { params: { id: 'up_1' } } as unknown as Request;
    const completeRes = mockResponse();
    await invokeHandler(completeResumableUpload, completeReq, completeRes);

    expect(completeRes.json).toHaveBeenCalledWith(expect.objectContaining({ cid: CID }));
  });

  it('rejects completion of a denylisted upload', async () => {
    mockComplete.mockRejectedValue(
      Object.assign(new Error('Content unavailable for legal reasons'), { statusCode: 451 })
    );
    const req = { params: { id: 'up_1' } } as unknown as Request;
    const res = mockResponse();

    const { next } = await invokeHandler(completeResumableUpload, req, res);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 451 }));
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
