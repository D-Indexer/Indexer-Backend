import { createStatsRoutes, resolveDailyRange } from '../routes/stats.routes';
import { STATS_DAILY_SQL } from '../services/stats';
import { serve, type TestServer } from './httpHarness';

const NOW = new Date('2026-11-28T15:30:00Z');

describe('resolveDailyRange', () => {
  it('defaults to the last 30 days ending today (UTC)', () => {
    expect(resolveDailyRange({}, NOW)).toEqual({ from: '2026-10-30', to: '2026-11-28' });
  });

  it('defaults from to 30 days before to', () => {
    expect(resolveDailyRange({ to: '2026-03-01' }, NOW)).toEqual({ from: '2026-01-31', to: '2026-03-01' });
  });

  it('defaults to to 30 days after from', () => {
    expect(resolveDailyRange({ from: '2026-01-01' }, NOW)).toEqual({ from: '2026-01-01', to: '2026-01-30' });
  });

  it('accepts exactly 366 days and a single day', () => {
    expect(resolveDailyRange({ from: '2024-01-01', to: '2024-12-31' }, NOW)).toEqual({
      from: '2024-01-01',
      to: '2024-12-31',
    });
    expect(resolveDailyRange({ from: '2026-11-01', to: '2026-11-01' }, NOW)).toEqual({
      from: '2026-11-01',
      to: '2026-11-01',
    });
  });

  it.each([
    [{ from: '2025-01-01', to: '2026-01-02' }, 'Date range must be at most 366 days'],
    [{ from: '2026-11-02', to: '2026-11-01' }, 'from must not be after to'],
    [{ from: '2026-02-30' }, 'from must be a date in YYYY-MM-DD format'],
    [{ to: '2026-1-1' }, 'to must be a date in YYYY-MM-DD format'],
    [{ from: ['2026-01-01', '2026-01-02'] }, 'from must be a date in YYYY-MM-DD format'],
  ])('rejects %j', (query, message) => {
    expect(() => resolveDailyRange(query, NOW)).toThrow(message);
  });
});

describe('stats routes', () => {
  let server: TestServer;
  const db = { query: jest.fn() };

  beforeAll(async () => {
    server = await serve({ '/stats': createStatsRoutes({ db: db as any, now: () => NOW }) });
  });
  afterAll(() => server.close());
  afterEach(() => db.query.mockReset());

  it('returns totals', async () => {
    db.query.mockResolvedValue({
      rows: [
        { folders_claimed: '3', portfolios_minted: '2', portfolio_updates: '9', templates_registered: '1' },
      ],
    });

    const res = await server.get('/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      foldersClaimed: 3,
      portfoliosMinted: 2,
      portfolioUpdates: 9,
      templatesRegistered: 1,
    });
  });

  it('returns the daily series for the requested range', async () => {
    db.query.mockResolvedValue({
      rows: [
        {
          day: '2026-11-01',
          folders_claimed: '1',
          portfolios_minted: '0',
          portfolio_updates: '0',
          templates_registered: '1',
        },
      ],
    });

    const res = await server.get('/stats/daily?from=2026-11-01&to=2026-11-01');

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledWith(STATS_DAILY_SQL, ['2026-11-01', '2026-11-01']);
    expect(res.body).toEqual({
      from: '2026-11-01',
      to: '2026-11-01',
      days: [
        {
          day: '2026-11-01',
          foldersClaimed: 1,
          portfoliosMinted: 0,
          portfolioUpdates: 0,
          templatesRegistered: 1,
        },
      ],
    });
  });

  it('rejects ranges over 366 days with 400 without querying', async () => {
    const res = await server.get('/stats/daily?from=2020-01-01&to=2026-01-01');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Date range must be at most 366 days' });
    expect(db.query).not.toHaveBeenCalled();
  });
});
