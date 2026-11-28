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
