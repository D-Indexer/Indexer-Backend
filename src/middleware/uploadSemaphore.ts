import { Request, Response, NextFunction } from 'express';

/**
 * Process-wide counting semaphore used to bound the number of concurrent
 * in-memory uploads. Each upload buffers up to 10 MB in memory (via
 * `multer.memoryStorage()`) and then copies it into a `Blob`/`FormData`, so
 * unbounded concurrency can exhaust the heap and get the container OOM-killed.
 *
 * The semaphore is acquired *before* multer starts buffering. When saturated,
 * we respond `503` with `Retry-After` and destroy the socket without reading
 * the request body, so we don't pay the cost of draining it.
 */

const DEFAULT_UPLOAD_MAX_CONCURRENT = 4;

function resolveMaxConcurrent(): number {
  const raw = process.env.UPLOAD_MAX_CONCURRENT;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_UPLOAD_MAX_CONCURRENT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_UPLOAD_MAX_CONCURRENT;
  }
  return parsed;
}

const MAX_CONCURRENT = resolveMaxConcurrent();

/** Number of upload slots currently held. */
let active = 0;

/** Returns the configured maximum number of concurrent uploads. */
export function getUploadMaxConcurrent(): number {
  return MAX_CONCURRENT;
}

/** Returns the number of upload slots currently in use. */
export function getActiveUploadCount(): number {
  return active;
}

/**
 * Attempts to acquire an upload slot. Returns `true` on success (caller is
 * responsible for releasing it), `false` when the semaphore is saturated.
 */
export function tryAcquireUploadSlot(): boolean {
  if (active >= MAX_CONCURRENT) {
    return false;
  }
  active += 1;
  return true;
}

/** Releases a previously acquired upload slot. */
export function releaseUploadSlot(): void {
  if (active > 0) {
    active -= 1;
  }
}

/**
 * Express middleware that gates uploads behind the process-wide semaphore.
 *
 * Must run *before* multer so we never start buffering a body we can't serve.
 * On saturation we respond `503` with `Retry-After` and destroy the socket
 * without reading the body.
 */
export function uploadSemaphore(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!tryAcquireUploadSlot()) {
    // Tell the client to back off. `Retry-After` is in seconds.
    res.setHeader('Retry-After', '1');
    res.setHeader('Connection', 'close');
    res.status(503).json({
      error: 'Too many concurrent uploads',
      message: 'Server is busy processing uploads. Please retry shortly.',
    });

    // Close the connection to avoid draining the (potentially large) body.
    // `req.destroy()` tears down the underlying socket.
    if (typeof req.destroy === 'function') {
      req.destroy();
    }
    return;
  }

  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    releaseUploadSlot();
  };

  // Release the slot once the response is fully sent or the connection closes.
  res.once('finish', release);
  res.once('close', release);

  next();
}

export default uploadSemaphore;