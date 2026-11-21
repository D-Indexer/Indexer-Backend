import { getEnv } from '../config/env';
import { logger } from '../utils/logger';

type Db = { query(sql: string, params?: unknown[]): Promise<unknown> };

export type ReconcileResult = { pinned: number; unavailable: number; checked: number };

export async function reconcileCid(
  db: Db,
  cid: string,
  fetchImpl: typeof fetch = fetch
): Promise<'pinned' | 'unavailable'> {
  const env = getEnv();
  try {
    const lsUrl = new URL('/api/v0/pin/ls', env.IPFS_API_URL);
    lsUrl.searchParams.set('arg', cid);
    const lsResponse = await fetchImpl(lsUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(env.IPFS_TIMEOUT_MS),
    });

    if (!lsResponse.ok) {
      throw new Error(`pin ls failed with status ${lsResponse.status}`);
    }
    const ls = (await lsResponse.json()) as { Keys?: Record<string, unknown> };
    if (ls.Keys && Object.prototype.hasOwnProperty.call(ls.Keys, cid)) {
      await db.query(
        `INSERT INTO ipfs_cid_status (cid, status, last_checked_at, last_error, attempts, next_check_at)
         VALUES ($1, 'pinned', NOW(), NULL, 0, NULL)
         ON CONFLICT (cid) DO UPDATE SET status = 'pinned', last_checked_at = NOW(),
           last_error = NULL, attempts = 0, next_check_at = NULL`,
        [cid]
      );
      return 'pinned';
    }

    const addUrl = new URL('/api/v0/pin/add', env.IPFS_API_URL);
    addUrl.searchParams.set('arg', cid);
    const addResponse = await fetchImpl(addUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(env.IPFS_TIMEOUT_MS),
    });
    if (!addResponse.ok) {
      throw new Error(`pin add failed with status ${addResponse.status}`);
    }
    await db.query(
      `INSERT INTO ipfs_cid_status (cid, status, last_checked_at, last_error, attempts, next_check_at)
       VALUES ($1, 'pinned', NOW(), NULL, 0, NULL)
       ON CONFLICT (cid) DO UPDATE SET status = 'pinned', last_checked_at = NOW(),
         last_error = NULL, attempts = 0, next_check_at = NULL`,
      [cid]
    );
    return 'pinned';
  } catch (err) {
    const message = err instanceof Error ? err.name === 'TimeoutError' ? 'IPFS node timed out' : err.message : String(err);
    await db.query(
      `INSERT INTO ipfs_cid_status (cid, status, last_checked_at, last_error, attempts, next_check_at)
       VALUES ($1, 'unavailable', NOW(), $2, 1,
               NOW() + INTERVAL '5 minutes')
       ON CONFLICT (cid) DO UPDATE SET status = 'unavailable', last_checked_at = NOW(),
         last_error = $2, attempts = ipfs_cid_status.attempts + 1,
         next_check_at = NOW() + (LEAST(60, 5 * POWER(2, ipfs_cid_status.attempts)) * INTERVAL '1 minute')`,
      [cid, message]
    );
    logger.warn('IPFS CID unavailable', { cid, error: message });
    return 'unavailable';
  }
}

export async function reconcileAll(db: Db, fetchImpl: typeof fetch = fetch): Promise<ReconcileResult> {
  const result: ReconcileResult = { pinned: 0, unavailable: 0, checked: 0 };
  const cids = new Set<string>();
  const portfolioResult = await db.query('SELECT ipfs_cid FROM portfolios');
  for (const row of (portfolioResult as { rows: Array<{ ipfs_cid: string }> }).rows) cids.add(row.ipfs_cid);
  const templateResult = await db.query('SELECT metadata_uri FROM templates');
  for (const row of (templateResult as { rows: Array<{ metadata_uri: string }> }).rows) {
    if (row.metadata_uri.startsWith('ipfs://')) cids.add(row.metadata_uri.slice('ipfs://'.length));
  }

  for (const cid of cids) {
    result.checked++;
    const status = await reconcileCid(db, cid, fetchImpl);
    if (status === 'pinned') result.pinned++;
    else result.unavailable++;
  }
  return result;
}
