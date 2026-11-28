import { Router, type Request, type Response } from 'express';
import type { Queryable } from '../db/types';
import { badRequest } from '../http/errors';
import { getDaily, getTotals } from '../services/stats';

export interface StatsRoutesDeps {
  db: Queryable;
  /** Clock for the default range; injectable for tests. */
  now?: () => Date;
}

/** Longest range /stats/daily serves, inclusive of both ends. */
export const MAX_DAILY_RANGE_DAYS = 366;
/** Range served when neither `from` nor `to` is given: the last 30 days. */
export const DEFAULT_DAILY_RANGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parse a YYYY-MM-DD query value into a UTC midnight Date, rejecting impossible dates like 2026-02-30. */
function parseDay(raw: unknown, name: string): Date | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw badRequest(`${name} must be a date in YYYY-MM-DD format`);
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || toDay(date) !== raw) {
    throw badRequest(`${name} must be a date in YYYY-MM-DD format`);
  }
  return date;
}

export function resolveDailyRange(query: Record<string, unknown>, now: Date): { from: string; to: string } {
  const fromDate = parseDay(query['from'], 'from');
  const toDate = parseDay(query['to'], 'to');
  const span = (DEFAULT_DAILY_RANGE_DAYS - 1) * DAY_MS;

  const to =
    toDate ?? (fromDate ? new Date(fromDate.getTime() + span) : new Date(`${toDay(now)}T00:00:00.000Z`));
  const from = fromDate ?? new Date(to.getTime() - span);

  if (from > to) throw badRequest('from must not be after to');
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > MAX_DAILY_RANGE_DAYS) {
    throw badRequest(`Date range must be at most ${MAX_DAILY_RANGE_DAYS} days`);
  }
  return { from: toDay(from), to: toDay(to) };
}

export function createStatsRoutes({ db, now = () => new Date() }: StatsRoutesDeps): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    res.json(await getTotals(db));
  });

  router.get('/daily', async (req: Request, res: Response) => {
    const { from, to } = resolveDailyRange(req.query, now());
    res.json({ from, to, days: await getDaily(db, from, to) });
  });

  return router;
}

export default createStatsRoutes;
