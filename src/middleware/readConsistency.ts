import { Request, Response, NextFunction } from 'express';
import pool from '../db/client';
import { getEnv } from '../config/env';
import { readState, STATE } from '../indexer/stellar';
import { badRequest, tooEarly } from '../http/errors';
import { minLedgerSchema } from '../validation/schemas';

/** `indexer_state.last_ledger` is cached per process for at most this long. */
const LEDGER_CACHE_TTL_MS = 1000;
/** Poll interval while waiting for the indexer to reach `minLedger`. */
const WAIT_POLL_MS = 100;

let cachedLedger: { value: number | null; at: number } | null = null;

/** Highest ledger the indexer has applied, or `null` when it has not started. */
export async function getIndexedLedger(): Promise<number | null> {
  const now = Date.now();
  if (cachedLedger && now - cachedLedger.at < LEDGER_CACHE_TTL_MS) return cachedLedger.value;

  const state = await readState(pool);
  const raw = state[STATE.lastLedger];
  const parsed = raw === undefined ? NaN : Number(raw);
  const value = Number.isSafeInteger(parsed) ? parsed : null;
  cachedLedger = { value, at: now };
  return value;
}

/** Test hook: drop the cached ledger so the next read hits the database. */
export function resetIndexedLedgerCache(): void {
  cachedLedger = null;
}

/** Test hook: seed the cached ledger without touching the database. */
export function setIndexedLedgerCache(value: number | null): void {
  cachedLedger = { value, at: Date.now() };
}

function requestedMinLedger(req: Request): number | null {
  const fromQuery = req.query.minLedger;
  const fromHeader = req.header('x-min-ledger');
  const raw = typeof fromQuery === 'string' ? fromQuery : fromHeader;
  if (raw === undefined || raw.trim() === '') return null;

  const parsed = minLedgerSchema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);
  return parsed.data;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read-your-writes guard for read endpoints: sets `X-Indexed-Ledger` on every
 * response and, when the client asks for `minLedger`, waits up to
 * `API_MIN_LEDGER_WAIT_MS` for the indexer to reach it before answering 425.
 */
export async function readConsistency(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const minLedger = requestedMinLedger(req);
    let indexed = await getIndexedLedger();

    if (minLedger !== null) {
      const deadline = Date.now() + getEnv().API_MIN_LEDGER_WAIT_MS;
      while ((indexed === null || indexed < minLedger) && Date.now() < deadline) {
        await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
        resetIndexedLedgerCache();
        indexed = await getIndexedLedger();
      }

      if (indexed === null || indexed < minLedger) {
        if (indexed !== null) res.setHeader('X-Indexed-Ledger', String(indexed));
        throw tooEarly(
          `Indexer has not reached ledger ${minLedger} yet (currently at ${indexed ?? 'none'})`,
          { 'Retry-After': '1' }
        );
      }
    }

    if (indexed !== null) res.setHeader('X-Indexed-Ledger', String(indexed));
    next();
  } catch (err) {
    next(err);
  }
}
