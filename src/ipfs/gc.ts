import { getEnv } from '../config/env';
import { logger } from '../utils/logger';

type Db = { query(sql: string, params?: unknown[]): Promise<unknown> };

export type GcOptions = { olderThanDays: number; dryRun?: boolean };
export type GcResult = { eligible: number; unpinned: number; dryRun: number };

export async function runGc(db: Db, options: GcOptions, fetchImpl: typeof fetch = fetch): Promise<GcResult> {
  if (!Number.isInteger(options.olderThanDays) || options.olderThanDays < 0) {
    throw new Error('older-than must be a non-negative whole number of days');
  }
  const result: GcResult = { eligible: 0, unpinned: 0, dryRun: 0 };
  const env = getEnv();

  const referenced = await db.query(
    `SELECT ipfs_cid AS cid FROM portfolios
     UNION
     SELECT metadata_uri AS cid FROM templates WHERE metadata_uri LIKE 'ipfs://%'`
  );
  const referencedCids = new Set(
    ((referenced as { rows: Array<{ cid: string }> }).rows ?? []).map((row) =>
      row.cid.startsWith('ipfs://') ? row.cid.slice(7) : row.cid
    )
  );

  const eligible = await db.query(
    `SELECT cid FROM uploads
     WHERE referenced_at IS NULL
       AND created_at < NOW() - ($1 * INTERVAL '1 day')
     ORDER BY created_at`,
    [options.olderThanDays]
  );
  for (const row of (eligible as { rows: Array<{ cid: string }> }).rows ?? []) {
    if (referencedCids.has(row.cid)) continue;
    result.eligible++;
    if (options.dryRun) {
      await db.query(
        `INSERT INTO ipfs_gc_actions (cid, action, reason) VALUES ($1, 'dry-run', 'unreferenced upload')
         ON CONFLICT (cid) DO UPDATE SET action = 'dry-run', reason = EXCLUDED.reason, acted_at = NOW()`,
        [row.cid]
      );
      result.dryRun++;
      continue;
    }

    const url = new URL('/api/v0/pin/rm', env.IPFS_API_URL);
    url.searchParams.set('arg', row.cid);
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(env.IPFS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`pin rm failed for ${row.cid} with status ${response.status}`);
    await db.query(
      `INSERT INTO ipfs_gc_actions (cid, action, reason) VALUES ($1, 'unpinned', 'unreferenced upload')
       ON CONFLICT (cid) DO UPDATE SET action = 'unpinned', reason = EXCLUDED.reason, acted_at = NOW()`,
      [row.cid]
    );
    await db.query('DELETE FROM uploads WHERE cid = $1', [row.cid]);
    result.unpinned++;
    logger.info('Unpinned unreferenced upload', { cid: row.cid });
  }
  return result;
}
