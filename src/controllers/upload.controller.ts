import { Request, Response } from 'express';
import { pinFile, isCidDenylisted, isContentHashDenylisted } from '../services/ipfs';
import { asyncHandler } from '../middleware/asyncHandler';
import { uploadFileSchema } from '../validation/schemas';
import { sniffContentType } from '../validation/fileType';
import { badRequest, forbidden } from '../http/errors';
import { createHash } from 'crypto';

const MAX_FILENAME_LENGTH = 100;
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
};

/**
 * Sanitise a client-supplied filename so it is safe to forward to Kubo.
 *
 * - Strips path separators, control characters (including NUL/CR/LF) and
 *   unicode tricks (RTL overrides, bidi controls).
 * - Restricts to `[A-Za-z0-9._-]`.
 * - Truncates to 100 characters.
 * - Falls back to a server-chosen `upload.<ext>` name derived from the
 *   sniffed content type when the sanitised result is empty or unsafe.
 *
 * The result is always non-empty and matches `[A-Za-z0-9._-]{1,100}`.
 */
export function sanitiseFilename(originalName: string | undefined, mimetype: string): string {
  const ext = EXTENSION_BY_MIME[mimetype] ?? 'bin';
  const fallback = `upload.${ext}`;

  if (!originalName) return fallback;

  // Remove path separators and any control / bidi characters.
  // eslint-disable-next-line no-control-regex
  const stripped = originalName
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/]/g, '');

  // Keep only the final segment in case separators survived.
  const base = stripped.split(/[\\/]/).pop() ?? '';

  // Restrict to the safe character set.
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '');

  // Reject names that are only dots (e.g. "..", ".").
  const trimmed = cleaned.replace(/^\.+/, '').replace(/\.+$/, '');

  if (!trimmed) return fallback;

  const truncated = trimmed.slice(0, MAX_FILENAME_LENGTH);

  if (!SAFE_FILENAME_PATTERN.test(truncated)) return fallback;

  return truncated;
}

export const upload = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw badRequest('No file provided');

  const result = uploadFileSchema.safeParse({ mimetype: file.mimetype, size: file.size });
  if (!result.success) throw badRequest(result.error.errors[0].message);

  if (sniffContentType(file.buffer) !== file.mimetype) {
    throw badRequest('File content does not match its declared type');
  }

  // #213: reject re-uploads of denylisted content by content hash.
  const contentHash = createHash('sha256').update(file.buffer).digest('hex');
  if (await isContentHashDenylisted(contentHash)) {
    throw forbidden('Content is unavailable for legal reasons');
  }

  // #212: never forward the raw client filename to Kubo.
  const safeName = sanitiseFilename(file.originalname, file.mimetype);

  const cid = await pinFile(file.buffer, safeName);

  // #213: flag denylisted CIDs in the response.
  const removed = await isCidDenylisted(cid);

  res.json(removed ? { cid, contentRemoved: true } : { cid });
});