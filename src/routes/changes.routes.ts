import { Router, Request, Response } from 'express';
import { getChanges, InvalidCursorError } from '../services/changes';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const router = Router();

function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_LIMIT;
  }
  if (Array.isArray(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return Math.min(value, MAX_LIMIT);
}

router.get('/changes', async (req: Request, res: Response) => {
  const limit = parseLimit(req.query.limit);
  if (limit === null) {
    res.status(400).json({
      error: 'invalid_limit',
      message: `limit must be a positive integer (max ${MAX_LIMIT})`,
    });
    return;
  }

  const sinceRaw = req.query.since;
  if (Array.isArray(sinceRaw)) {
    res.status(400).json({
      error: 'invalid_cursor',
      message: 'since must be a single opaque cursor string',
    });
    return;
  }
  const since = typeof sinceRaw === 'string' && sinceRaw.length > 0 ? sinceRaw : undefined;

  try {
    const { changes, nextCursor } = await getChanges({ since, limit });
    res.status(200).json({ changes, nextCursor });
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      res.status(410).json({
        error: 'cursor_expired',
        message:
          'The provided cursor is invalid or expired. Resync from the beginning by omitting the `since` parameter.',
        resync: {
          instruction: 'Restart the feed without a `since` cursor and replay all changes.',
          endpoint: '/changes',
        },
      });
      return;
    }
    throw err;
  }
});

export default router;