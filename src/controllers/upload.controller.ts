import { Request, Response } from 'express';
import { CarReader } from '@ipld/car';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import { pinFile, importCar } from '../services/ipfs';
import { asyncHandler } from '../middleware/asyncHandler';
import { uploadFileSchema } from '../validation/schemas';
import { sniffContentType } from '../validation/fileType';
import { validateManifest } from '../validation/manifest';
import { badRequest } from '../http/errors';

const MANIFEST_MIMETYPES = new Set(['application/json', 'application/ld+json']);

function isManifestUpload(file: Express.Multer.File, req: Request): boolean {
  if (MANIFEST_MIMETYPES.has(file.mimetype)) return true;
  if (typeof req.body?.manifest === 'string' && req.body.manifest.length > 0) return true;
  if (req.body?.manifest && typeof req.body.manifest === 'object') return true;
  return false;
}

function parseManifest(file: Express.Multer.File, req: Request): unknown {
  if (req.body?.manifest && typeof req.body.manifest === 'object') {
    return req.body.manifest;
  }
  if (typeof req.body?.manifest === 'string' && req.body.manifest.length > 0) {
    try {
      return JSON.parse(req.body.manifest);
    } catch {
      throw badRequest('Manifest field is not valid JSON');
    }
  }
  try {
    return JSON.parse(file.buffer.toString('utf8'));
  } catch {
    throw badRequest('Manifest file is not valid JSON');
  }
}

export const upload = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw badRequest('No file provided');

  const result = uploadFileSchema.safeParse({ mimetype: file.mimetype, size: file.size });
  if (!result.success) throw badRequest(result.error.errors[0].message);

  if (sniffContentType(file.buffer) !== file.mimetype) {
    throw badRequest('File content does not match its declared type');
  }

  if (isManifestUpload(file, req)) {
    const manifest = parseManifest(file, req);
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      const details = validation.errors
        .map((e) => `${e.path || '/'}: ${e.message}`)
        .join('; ');
      throw badRequest(`Invalid portfolio manifest: ${details}`);
    }
  }

  const cid = await pinFile(file.buffer, file.originalname);
  res.json({ cid });
});

async function verifyBlock(cid: CID, bytes: Uint8Array): Promise<boolean> {
  // Only verify hash integrity; we don't need to decode the block contents here.
  const hash = await sha256.digest(bytes);
  return cid.multihash.code === hash.code && Buffer.from(cid.multihash.bytes).equals(Buffer.from(hash.bytes));
}

async function extractUnixFsFiles(reader: CarReader): Promise<Array<{ cid: CID; bytes: Uint8Array }>> {
  // Collect blocks that look like UnixFS files (dag-pb with data). We return all
  // dag-pb blocks so the caller can apply content-type rules to file leaves.
  const files: Array<{ cid: CID; bytes: Uint8Array }> = [];
  for await (const block of reader.blocks()) {
    if (block.cid.code === raw.code) {
      files.push({ cid: block.cid, bytes: block.bytes });
    }
  }
  return files;
}

export const uploadCar = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw badRequest('No CAR file provided');

  let reader: CarReader;
  try {
    reader = await CarReader.fromBytes(file.buffer);
  } catch {
    throw badRequest('Invalid CAR file');
  }

  const roots = await reader.getRoots();
  if (roots.length !== 1) {
    throw badRequest(`CAR must have exactly one root, found ${roots.length}`);
  }

  // Verify every block's bytes hash to its CID before contacting Kubo.
  for await (const block of reader.blocks()) {
    const ok = await verifyBlock(block.cid, block.bytes);
    if (!ok) {
      throw badRequest(`Block hash mismatch for CID ${block.cid.toString()}`);
    }
  }

  // Apply content-type rules to UnixFS file leaves contained in the DAG.
  const files = await extractUnixFsFiles(reader);
  for (const f of files) {
    const sniffed = sniffContentType(Buffer.from(f.bytes));
    if (sniffed === 'application/octet-stream') {
      // Unknown binary content is not allowed inside a portfolio DAG.
      throw badRequest(`Disallowed content type in DAG block ${f.cid.toString()}`);
    }
  }

  const rootCid = roots[0].toString();
  await importCar(file.buffer, rootCid);

  res.json({ cid: rootCid });
});