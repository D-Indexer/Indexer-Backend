import { randomUUID } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { env } from '../config/env';
import { sniffContentType } from '../utils/contentSniffer';
import { uploadFileSchema } from '../schemas/upload.schema';
import { pinFile } from './ipfs';

/**
 * Resumable upload service implementing a minimal tus 1.0-compatible protocol.
 *
 * Design notes:
 *  - Partial chunks are stored on disk (never buffered fully in memory).
 *  - Each upload has a metadata file (JSON) and a data file (binary chunks).
 *  - Uploads expire after `env.RESUMABLE_UPLOAD_TTL_MS`; a periodic sweep
 *    removes abandoned uploads.
 *  - On completion the assembled file is validated with the same pipeline as
 *    single-request uploads (type sniffing, size, sanitisation) and pinned.
 */

export interface UploadMetadata {
  id: string;
  /** Expected total size in bytes (from the tus Upload-Length header). */
  size: number;
  /** Original filename provided by the client. */
  filename: string;
  /** Declared content type provided by the client. */
  contentType: string;
  /** Bytes received so far. */
  offset: number;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Last update timestamp (ms since epoch). */
  updatedAt: number;
}

export interface CreateUploadInput {
  size: number;
  filename: string;
  contentType: string;
}

export interface UploadResult {
  cid: string;
  size: number;
  contentType: string;
  filename: string;
}

export class ResumableUploadError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'resumable_upload_error') {
    super(message);
    this.name = 'ResumableUploadError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cleanupTimer: NodeJS.Timeout | null = null;

function getBaseDir(): string {
  return env.RESUMABLE_UPLOAD_DIR || path.join(tmpdir(), 'resumable-uploads');
}

function getTtlMs(): number {
  return env.RESUMABLE_UPLOAD_TTL_MS;
}

function getMaxSize(): number {
  return env.MAX_UPLOAD_SIZE_BYTES;
}

function dataPath(id: string): string {
  return path.join(getBaseDir(), `${id}.data`);
}

function metaPath(id: string): string {
  return path.join(getBaseDir(), `${id}.json`);
}

function assertValidId(id: string): void {
  if (!UPLOAD_ID_PATTERN.test(id)) {
    throw new ResumableUploadError('Invalid upload id', 400, 'invalid_upload_id');
  }
}

async function ensureBaseDir(): Promise<void> {
  await fs.mkdir(getBaseDir(), { recursive: true });
}

async function writeMetadata(meta: UploadMetadata): Promise<void> {
  const tmp = `${metaPath(meta.id)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta), 'utf8');
  await fs.rename(tmp, metaPath(meta.id));
}

async function readMetadata(id: string): Promise<UploadMetadata> {
  assertValidId(id);
  let raw: string;
  try {
    raw = await fs.readFile(metaPath(id), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ResumableUploadError('Upload not found', 404, 'upload_not_found');
    }
    throw err;
  }
  const meta = JSON.parse(raw) as UploadMetadata;
  if (isExpired(meta)) {
    await removeUpload(id).catch(() => undefined);
    throw new ResumableUploadError('Upload expired', 410, 'upload_expired');
  }
  return meta;
}

function isExpired(meta: UploadMetadata): boolean {
  return Date.now() - meta.updatedAt > getTtlMs();
}

/**
 * Create a new resumable upload session.
 */
export async function createUpload(input: CreateUploadInput): Promise<UploadMetadata> {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new ResumableUploadError('Upload-Length must be a positive integer', 400, 'invalid_length');
  }
  if (input.size > getMaxSize()) {
    throw new ResumableUploadError(
      `Upload exceeds maximum size of ${getMaxSize()} bytes`,
      413,
      'payload_too_large',
    );
  }

  await ensureBaseDir();

  const id = randomUUID();
  const now = Date.now();
  const meta: UploadMetadata = {
    id,
    size: Math.floor(input.size),
    filename: input.filename,
    contentType: input.contentType,
    offset: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Create an empty data file so subsequent appends have a target.
  await fs.writeFile(dataPath(id), Buffer.alloc(0));
  await writeMetadata(meta);

  return meta;
}

/**
 * Return current metadata (used for HEAD requests to report the offset).
 */
export async function getUpload(id: string): Promise<UploadMetadata> {
  return readMetadata(id);
}

/**
 * Append a chunk to an existing upload.
 *
 * The chunk is streamed directly to disk; it is never fully buffered in
 * memory beyond the stream's internal high-water mark.
 *
 * @param id Upload id
 * @param offset Expected current offset (from Upload-Offset header)
 * @param chunk Readable stream of the incoming chunk
 * @returns Updated metadata
 */
export async function appendChunk(
  id: string,
  offset: number,
  chunk: NodeJS.ReadableStream,
): Promise<UploadMetadata> {
  const meta = await readMetadata(id);

  if (offset !== meta.offset) {
    throw new ResumableUploadError(
      `Upload-Offset mismatch: expected ${meta.offset}, got ${offset}`,
      409,
      'offset_mismatch',
    );
  }

  if (meta.offset >= meta.size) {
    throw new ResumableUploadError('Upload already complete', 409, 'upload_complete');
  }

  const remaining = meta.size - meta.offset;
  let written = 0;

  const target = createWriteStream(dataPath(id), { flags: 'a' });

  try {
    await pipeline(
      chunk,
      async function* enforceLimit(source: AsyncIterable<Buffer>) {
        for await (const buf of source) {
          if (written + buf.length > remaining) {
            throw new ResumableUploadError(
              'Chunk exceeds declared Upload-Length',
              413,
              'chunk_too_large',
            );
          }
          written += buf.length;
          yield buf;
        }
      },
      target,
    );
  } catch (err) {
    // Ensure the stream is closed before propagating.
    target.destroy();
    throw err;
  }

  meta.offset += written;
  meta.updatedAt = Date.now();
  await writeMetadata(meta);

  return meta;
}

/**
 * Complete an upload: validate the assembled file with the same pipeline as
 * single-request uploads and pin it to IPFS.
 */
export async function completeUpload(id: string): Promise<UploadResult> {
  const meta = await readMetadata(id);

  if (meta.offset !== meta.size) {
    throw new ResumableUploadError(
      `Upload incomplete: received ${meta.offset} of ${meta.size} bytes`,
      409,
      'upload_incomplete',
    );
  }

  const filePath = dataPath(id);

  // Verify on-disk size matches declared size (guards against tampering).
  const stat = await fs.stat(filePath);
  if (stat.size !== meta.size) {
    throw new ResumableUploadError(
      'Stored file size does not match declared size',
      409,
      'size_mismatch',
    );
  }

  // Read a small prefix for content sniffing (never the whole file).
  const sniffBuffer = await readPrefix(filePath, 4096);
  const sniffedType = sniffContentType(sniffBuffer);

  // Run the shared validation schema against the assembled file metadata.
  const parsed = uploadFileSchema.safeParse({
    filename: meta.filename,
    contentType: sniffedType || meta.contentType,
    size: meta.size,
  });

  if (!parsed.success) {
    await removeUpload(id).catch(() => undefined);
    const message = parsed.error.issues.map((i) => i.message).join('; ');
    throw new ResumableUploadError(message, 400, 'validation_failed');
  }

  const stream = createReadStream(filePath);

  let cid: string;
  try {
    cid = await pinFile(stream, {
      filename: parsed.data.filename,
      contentType: parsed.data.contentType,
    });
  } finally {
    stream.destroy();
  }

  await removeUpload(id).catch(() => undefined);

  return {
    cid,
    size: meta.size,
    contentType: parsed.data.contentType,
    filename: parsed.data.filename,
  };
}

/**
 * Remove an upload's data and metadata files.
 */
export async function removeUpload(id: string): Promise<void> {
  assertValidId(id);
  await Promise.allSettled([fs.unlink(dataPath(id)), fs.unlink(metaPath(id))]);
}

/**
 * Sweep expired uploads. Returns the number of uploads removed.
 */
export async function cleanupExpiredUploads(): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(getBaseDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw err;
  }

  const now = Date.now();
  let removed = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (!UPLOAD_ID_PATTERN.test(id)) continue;

    try {
      const raw = await fs.readFile(path.join(getBaseDir(), entry), 'utf8');
      const meta = JSON.parse(raw) as UploadMetadata;
      if (now - meta.updatedAt > getTtlMs()) {
        await removeUpload(id);
        removed += 1;
      }
    } catch {
      // Corrupt or missing metadata: remove orphaned files.
      await removeUpload(id).catch(() => undefined);
      removed += 1;
    }
  }

  return removed;
}

/**
 * Start the periodic cleanup scheduler. Idempotent.
 */
export function startCleanupScheduler(intervalMs?: number): void {
  if (cleanupTimer) return;
  const interval = intervalMs ?? Math.max(60_000, Math.floor(getTtlMs() / 4));
  cleanupTimer = setInterval(() => {
    cleanupExpiredUploads().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[resumableUpload] cleanup failed', err);
    });
  }, interval);
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }
}

/**
 * Stop the periodic cleanup scheduler. Idempotent.
 */
export function stopCleanupScheduler(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

async function readPrefix(filePath: string, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}