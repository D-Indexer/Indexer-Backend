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

describe('upload semaphore', () => {
  const ORIGINAL = process.env.UPLOAD_MAX_CONCURRENT;

  beforeAll(() => {
    process.env.UPLOAD_MAX_CONCURRENT = '2';
  });

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.UPLOAD_MAX_CONCURRENT;
    else process.env.UPLOAD_MAX_CONCURRENT = ORIGINAL;
  });

  afterEach(() => jest.clearAllMocks());

  it('rejects the third concurrent upload with 503 and Retry-After', async () => {
    let release: (cid: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    mockPin.mockReturnValue(gate);

    const makeReq = () =>
      ({
        file: { buffer: PNG, originalname: 'test.png', mimetype: 'image/png', size: PNG.length },
      }) as unknown as Request;

    const first = invokeHandler(upload, makeReq(), mockResponse());
    const second = invokeHandler(upload, makeReq(), mockResponse());

    // Give the first two requests a chance to acquire their slots.
    await new Promise((r) => setImmediate(r));

    const thirdRes = mockResponse();
    const third = await invokeHandler(upload, makeReq(), thirdRes);

    expect(third.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503 }));
    expect(thirdRes.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));

    release('QmDone');
    await Promise.all([first, second]);
  });
});

/** Build a PNG signature + IHDR chunk declaring the given dimensions. */
function craftPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const type = Buffer.from('IHDR');
  const crc = Buffer.alloc(4); // CRC not validated by header sniffing
  return Buffer.concat([signature, length, type, ihdrData, crc]);
}

/** Build a JPEG SOI + SOF0 frame declaring the given dimensions. */
function craftJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]);
  const dims = Buffer.alloc(4);
  dims.writeUInt16BE(height, 0);
  dims.writeUInt16BE(width, 2);
  const rest = Buffer.from([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([soi, sof, dims, rest]);
}

/** Build a WebP (VP8X) header declaring the given canvas dimensions. */
function craftWebp(width: number, height: number): Buffer {
  const riff = Buffer.from('RIFF');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(30, 0);
  const webp = Buffer.from('WEBP');
  const vp8x = Buffer.from('VP8X');
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(10, 0);
  const flags = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  const dims = Buffer.alloc(6);
  dims.writeUIntLE(width - 1, 0, 3);
  dims.writeUIntLE(height - 1, 3, 3);
  return Buffer.concat([riff, size, webp, vp8x, chunkSize, flags, dims]);
}

/** Build a minimal PDF document from raw body content. */
function craftPdf(body: string, opts: { encrypted?: boolean } = {}): Buffer {
  const parts = ['%PDF-1.7\n'];
  if (opts.encrypted) {
    parts.push('1 0 obj\n<< /Filter /Standard /V 1 /R 2 >>\nendobj\n');
  }
  parts.push(body);
  parts.push('\ntrailer\n<< /Root 2 0 R >>\n%%EOF\n');
  return Buffer.from(parts.join(''));
}

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

  describe('image dimension limits', () => {
    it.each([
      ['PNG', craftPng(50_000, 50_000), 'image/png', 'bomb.png'],
      ['JPEG', craftJpeg(50_000, 50_000), 'image/jpeg', 'bomb.jpg'],
      ['WebP', craftWebp(50_000, 50_000), 'image/webp', 'bomb.webp'],
    ])('rejects a %s decompression bomb before decoding', async (_label, buffer, mimetype, name) => {
      const req = {
        file: { buffer, originalname: name, mimetype, size: buffer.length },
      } as unknown as Request;

      const { next } = await invokeHandler(upload, req);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 400, message: 'Image dimensions exceed limit' })
      );
      expect(mockPin).not.toHaveBeenCalled();
    });

    it.each([
      ['PNG', craftPng(800, 600), 'image/png', 'ok.png'],
      ['JPEG', craftJpeg(1920, 1080), 'image/jpeg', 'ok.jpg'],
      ['WebP', craftWebp(1024, 768), 'image/webp', 'ok.webp'],
    ])('accepts a normal %s image', async (_label, buffer, mimetype, name) => {
      mockPin.mockResolvedValue('QmNormal');
      const req = {
        file: { buffer, originalname: name, mimetype, size: buffer.length },
      } as unknown as Request;
      const res = mockResponse();

      const { next } = await invokeHandler(upload, req, res);

      expect(next).not.toHaveBeenCalled();
      expect(mockPin).toHaveBeenCalledWith(buffer, name);
      expect(res.json).toHaveBeenCalledWith({ cid: 'QmNormal' });
    });
  });

  describe('PDF active content', () => {
    it.each([
      ['JavaScript', '/JS (app.alert(1))'],
      ['JavaScript name', '/JavaScript (app.alert(1))'],
      ['Launch action', '/Launch << /F (cmd.exe) >>'],
      ['EmbeddedFile', '/EmbeddedFile << /Length 0 >>'],
      ['RichMedia', '/RichMedia << /Subtype /Sound >>'],
      ['OpenAction with JS', '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>'],
    ])('rejects a PDF containing %s', async (_label, body) => {
      const buffer = craftPdf(`2 0 obj\n<< /Type /Catalog ${body} >>\nendobj\n`);
      const req = {
        file: { buffer, originalname: 'doc.pdf', mimetype: 'application/pdf', size: buffer.length },
      } as unknown as Request;

      const { next } = await invokeHandler(upload, req);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(mockPin).not.toHaveBeenCalled();
    });

    it('rejects an encrypted PDF', async () => {
      const buffer = craftPdf('2 0 obj\n<< /Type /Catalog >>\nendobj\n', { encrypted: true });
      const req = {
        file: { buffer, originalname: 'enc.pdf', mimetype: 'application/pdf', size: buffer.length },
      } as unknown as Request;

      const { next } = await invokeHandler(upload, req);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(mockPin).not.toHaveBeenCalled();
    });

    it('accepts a plain text PDF', async () => {
      mockPin.mockResolvedValue('QmPdf');
      const buffer = craftPdf('2 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n');
      const req = {
        file: { buffer, originalname: 'plain.pdf', mimetype: 'application/pdf', size: buffer.length },
      } as unknown as Request;
      const res = mockResponse();

      const { next } = await invokeHandler(upload, req, res);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ cid: 'QmPdf' });
    });

    it('rejects a pathological PDF within a bounded time', async () => {
      const deep = '<< /Kids ['.repeat(5_000) + '] >>'.repeat(5_000);
      const buffer = craftPdf(`2 0 obj\n${deep}\nendobj\n`);
      const req = {
        file: { buffer, originalname: 'patho.pdf', mimetype: 'application/pdf', size: buffer.length },
      } as unknown as Request;

      const start = Date.now();
      const { next } = await invokeHandler(upload, req);
      const elapsed = Date.now() - start;

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(elapsed).toBeLessThan(5_000);
      expect(mockPin).not.toHaveBeenCalled();
    });
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

describe('upload bundle controller', () => {
  afterEach(() => jest.clearAllMocks());

  it('rejects a bundle with too many files', async () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      buffer: PNG,
      originalname: `f${i}.png`,
      mimetype: 'image/png',
      size: PNG.length,
    }));
    const req = { files, body: { manifest: '{}' } } as unknown as Request;

    const { next } = await invokeHandler(uploadBundle, req);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(mockPin).not.toHaveBeenCalled();
  });

  it('rejects a bundle whose total size exceeds the limit', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0x89);
    const files = [
      { buffer: big, originalname: 'a.png', mimetype: 'image/png', size: big.length },
      { buffer: big, originalname: 'b.png', mimetype: 'image/png', size: big.length },
    ];
    const req = { files, body: { manifest: '{}' } } as unknown as Request;

    const { next } = await invokeHandler(uploadBundle, req);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(mockPin).not.toHaveBeenCalled();
  });

  it('rejects a bundle containing an invalid file', async () => {
    const files = [
      { buffer: PNG, originalname: 'ok.png', mimetype: 'image/png', size: PNG.length },
      {
        buffer: Buffer.from('MZ\x90\x00'),
        originalname: 'evil.png',
        mimetype: 'image/png',
        size: 4,
      },
    ];
    const req = { files, body: { manifest: '{}' } } as unknown as Request;

    const { next } = await invokeHandler(uploadBundle, req);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(mockPin).not.toHaveBeenCalled();
  });

  it('rejects a bundle with an invalid manifest', async () => {
    const files = [{ buffer: PNG, originalname: 'ok.png', mimetype: 'image/png', size: PNG.length }];
    const req = { files, body: { manifest: 'not-json' } } as unknown as Request;

    const { next } = await invokeHandler(uploadBundle, req);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(mockPin).not.toHaveBeenCalled();
  });
});
