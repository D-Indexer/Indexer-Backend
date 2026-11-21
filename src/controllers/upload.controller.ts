import { Request, Response } from 'express';
import { pinFile } from '../services/ipfs';
import { asyncHandler } from '../middleware/asyncHandler';
import { uploadFileSchema } from '../validation/schemas';
import { sniffContentType } from '../validation/fileType';
import { badRequest } from '../http/errors';
import { createHash } from 'crypto';
import pool from '../db/client';
import { sanitizeImage } from '../services/imageSanitize';

export const upload = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw badRequest('No file provided');

  const result = uploadFileSchema.safeParse({ mimetype: file.mimetype, size: file.size });
  if (!result.success) throw badRequest(result.error.errors[0].message);

  if (sniffContentType(file.buffer) !== file.mimetype) {
    throw badRequest('File content does not match its declared type');
  }

  const keepMetadata = req.query?.keepMetadata === 'true';
  const sanitized =
    file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'image/webp'
      ? await sanitizeImage(file.buffer, file.mimetype, keepMetadata)
      : file.buffer;

  const cid = await pinFile(sanitized, file.originalname);
  const sha256 = createHash('sha256').update(sanitized).digest('hex');
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const clientIpHash = createHash('sha256').update(ip).digest('hex');
  await pool.query(
    `INSERT INTO uploads (cid, size, mime, sha256, client_ip_hash, request_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (cid) DO UPDATE SET created_at = uploads.created_at`,
    [cid, sanitized.byteLength, file.mimetype, sha256, clientIpHash, req.id]
  );
  res.json({ cid });
});
