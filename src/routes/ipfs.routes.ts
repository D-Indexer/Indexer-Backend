import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { logger } from '../utils/logger';
import { isCidReferenced } from '../services/ipfs';

const router = Router();

const IPFS_GATEWAY = process.env.IPFS_GATEWAY || 'http://127.0.0.1:8080';
const IPFS_API = process.env.IPFS_API || 'http://127.0.0.1:5001';

// CIDv0: Qm... (base58btc, 46 chars)
// CIDv1: b... (base32) or other multibase prefixes; keep it permissive but safe.
const CID_V0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_REGEX = /^[a-z2-7]{40,}$/i;

function isValidCid(cid: string): boolean {
  if (!cid || cid.length > 128) return false;
  if (CID_V0_REGEX.test(cid)) return true;
  // CIDv1 base32 (lowercase) typically starts with 'b'
  if (/^b[a-z2-7]{20,}$/.test(cid)) return true;
  // Be permissive for other multibase encodings but reject path traversal / control chars
  if (CID_V1_REGEX.test(cid) && !cid.includes('..') && !/[\s/\\]/.test(cid)) return true;
  return false;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
};

function sniffContentType(path: string, upstreamType?: string | null): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext && CONTENT_TYPE_BY_EXT[ext]) {
    return CONTENT_TYPE_BY_EXT[ext];
  }
  if (upstreamType && upstreamType !== 'application/octet-stream') {
    return upstreamType;
  }
  return 'application/octet-stream';
}

function setSecurityHeaders(res: Response, cid: string): void {
  res.setHeader('ETag', `"${cid}"`);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  );
}

function buildUpstreamUrl(cid: string, subPath: string): string {
  const encodedPath = subPath
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const base = `${IPFS_API}/api/v0/cat?arg=${encodeURIComponent(`/ipfs/${cid}`)}`;
  return encodedPath ? `${base}/${encodedPath}` : base;
}

async function streamFromKubo(
  req: Request,
  res: Response,
  cid: string,
  subPath: string,
): Promise<void> {
  const url = buildUpstreamUrl(cid, subPath);

  const headers: Record<string, string> = {};
  if (req.headers.range) {
    headers['Range'] = req.headers.range;
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, { method: 'POST', headers });
  } catch (err) {
    logger.error({ err, cid }, 'Failed to contact Kubo for IPFS content');
    if (!res.headersSent) {
      res.status(502).json({ error: 'IPFS gateway unavailable' });
    }
    return;
  }

  if (upstream.status === 404) {
    if (!res.headersSent) {
      res.status(404).json({ error: 'Content not found' });
    }
    return;
  }

  if (!upstream.ok && upstream.status !== 206) {
    logger.warn({ cid, status: upstream.status }, 'Kubo returned non-OK status');
    if (!res.headersSent) {
      res.status(502).json({ error: 'IPFS gateway error' });
    }
    return;
  }

  const contentType = sniffContentType(subPath, upstream.headers.get('content-type'));
  setSecurityHeaders(res, cid);
  res.setHeader('Content-Type', contentType);

  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  const acceptRanges = upstream.headers.get('accept-ranges') ?? 'bytes';

  if (contentRange) {
    res.setHeader('Content-Range', contentRange);
  }
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  }
  res.setHeader('Accept-Ranges', acceptRanges);

  res.status(upstream.status === 206 ? 206 : 200);

  if (!upstream.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(
    upstream.body as unknown as import('stream/web').ReadableStream<Uint8Array>,
  );

  try {
    await pipeline(nodeStream, res);
  } catch (err) {
    // Client disconnects / aborted streams are expected; log at debug level.
    logger.debug({ err, cid }, 'IPFS stream terminated');
    if (!res.writableEnded) {
      res.destroy();
    }
  }
}

router.get('/:cid/*', async (req: Request, res: Response) => {
  const rawCid = req.params.cid;
  const subPath = (req.params as Record<string, unknown>)[0] as string | undefined;

  if (!rawCid || !isValidCid(rawCid)) {
    res.status(400).json({ error: 'Invalid CID' });
    return;
  }

  const cid = rawCid;

  let referenced: boolean;
  try {
    referenced = await isCidReferenced(cid);
  } catch (err) {
    logger.error({ err, cid }, 'Failed to check IPFS allow-list');
    res.status(500).json({ error: 'Internal error' });
    return;
  }

  if (!referenced) {
    // Do not contact Kubo for unreferenced CIDs.
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const safeSubPath = (subPath ?? '').replace(/^\/+/, '');
  if (safeSubPath.split('/').some((seg) => seg === '..' || seg === '.')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  await streamFromKubo(req, res, cid, safeSubPath);
});

// Also support the bare CID (no sub-path) case.
router.get('/:cid', async (req: Request, res: Response) => {
  const rawCid = req.params.cid;

  if (!rawCid || !isValidCid(rawCid)) {
    res.status(400).json({ error: 'Invalid CID' });
    return;
  }

  let referenced: boolean;
  try {
    referenced = await isCidReferenced(rawCid);
  } catch (err) {
    logger.error({ err, cid: rawCid }, 'Failed to check IPFS allow-list');
    res.status(500).json({ error: 'Internal error' });
    return;
  }

  if (!referenced) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  await streamFromKubo(req, res, rawCid, '');
});

export default router;