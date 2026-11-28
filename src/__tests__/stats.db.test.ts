import type { PoolClient } from 'pg';
import { rebuildDailyStats, updateCounters } from '../indexer/counters';
import type { DecodedEvent } from '../indexer/decode';
import { createStatsRoutes } from '../routes/stats.routes';
import { getDaily, getTotals } from '../services/stats';
import { serve } from './httpHarness';
import { createTestSchema, describeDb, type TestSchema } from './pgSchema';
import { ingest, type FixtureEvent } from './readModel';

const A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

const claim = (owner: string): DecodedEvent => ({
  topic: 'folder_cl',
  owner,
  folderName: `${owner[1]}.folder`,
});
const reg = (templateId: number, uri = 'ipfs://t'): DecodedEvent => ({
  topic: 'tmpl_reg',
  templateId,
  metadataUri: uri,
  creator: null,
});
const mint = (owner: string, templateId: number): DecodedEvent => ({
  topic: 'port_mint',
  owner,
  templateId,
  ipfsCid: 'bafkmint',
});
const upd = (owner: string): DecodedEvent => ({ topic: 'port_upd', owner, ipfsCid: 'bafkupd' });
const set = (owner: string, templateId: number): DecodedEvent => ({ topic: 'tmpl_set', owner, templateId });

let seq = 0;
function fx(at: string, event: DecodedEvent, reject = false): FixtureEvent {
  seq += 1;
  return { id: `${String(seq).padStart(19, '0')}-0000000001`, ledger: 1000 + seq, at, event, reject };
}

/**
 * Fixture set covering every counting rule: re-claims, re-registrations and
 * re-mints don't count again; port_upd always counts; rejected events never
 * count (and a rejected first claim doesn't stop a later applied one from
 * counting); days are UTC calendar days of the ledger close.
 */
const FIXTURES: FixtureEvent[] = [
  fx('2026-11-01T10:00:00Z', reg(1)),
  fx('2026-11-01T23:59:59Z', claim(A)),
  fx('2026-11-02T00:00:00Z', claim(A)), // re-claim
  fx('2026-11-02T01:00:00Z', reg(1, 'ipfs://t-v2')), // re-registration
  fx('2026-11-02T02:00:00Z', reg(2)),
  fx('2026-11-02T03:00:00Z', mint(A, 1)),
  fx('2026-11-02T04:00:00Z', upd(A)),
  fx('2026-11-02T05:00:00Z', upd(A)),
  fx('2026-11-03T00:00:00Z', claim(B)),
  fx('2026-11-03T01:00:00Z', mint(B, 2)),
  fx('2026-11-03T02:00:00Z', mint(A, 2)), // re-mint
  fx('2026-11-03T03:00:00Z', set(A, 1)),
  fx('2026-11-03T04:00:00Z', upd(B), true), // rejected
  fx('2026-11-03T05:00:00Z', claim(C), true), // rejected
  fx('2026-11-05T12:00:00+02:00', claim(C)), // 10:00 UTC
];

const EXPECTED = [
  {
    day: '2026-11-01',
    folders_claimed: 1,
    portfolios_minted: 0,
    portfolio_updates: 0,
    templates_registered: 1,
  },
  {
    day: '2026-11-02',
    folders_claimed: 0,
    portfolios_minted: 1,
    portfolio_updates: 2,
    templates_registered: 1,
  },
  {
    day: '2026-11-03',
    folders_claimed: 1,
    portfolios_minted: 1,
    portfolio_updates: 0,
    templates_registered: 0,
  },
  {
    day: '2026-11-05',
    folders_claimed: 1,
    portfolios_minted: 0,
    portfolio_updates: 0,
    templates_registered: 0,
  },
];

describeDb('daily stats against Postgres', () => {
  let schema: TestSchema;
  let client: PoolClient;

  async function snapshot() {
    const { rows } = await schema.pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, folders_claimed::int, portfolios_minted::int,
              portfolio_updates::int, templates_registered::int
         FROM daily_stats ORDER BY day`
    );
    return rows;
  }

  async function ingestAll(events: FixtureEvent[]): Promise<number> {
    let inserted = 0;
    for (const event of events) if (await ingest(client, event)) inserted += 1;
    return inserted;
  }

  beforeAll(async () => {
    schema = await createTestSchema('test_daily_stats');
  });
  beforeEach(async () => {
    await schema.reset();
    client = await schema.pool.connect();
  });
  afterEach(() => client.release());
  afterAll(() => schema.close());

  it('maintains the expected values incrementally', async () => {
    await ingestAll(FIXTURES);
    expect(await snapshot()).toEqual(EXPECTED);
  });

  it('rebuild-stats output equals the incrementally maintained values', async () => {
    await ingestAll(FIXTURES);
    const incremental = await snapshot();

    const { days } = await rebuildDailyStats(client);

    expect(days).toBe(EXPECTED.length);
    expect(await snapshot()).toEqual(incremental);
  });

  it('does not double count under replay, and rebuild is idempotent', async () => {
    await ingestAll(FIXTURES);
    // Replay every page, as after a crash or a cursor rewind: all duplicates.
    expect(await ingestAll(FIXTURES)).toBe(0);
    expect(await snapshot()).toEqual(EXPECTED);

    await rebuildDailyStats(client);
    await rebuildDailyStats(client);
    expect(await snapshot()).toEqual(EXPECTED);
  });

  it('rebuild repairs drifted or missing rows', async () => {
    await ingestAll(FIXTURES);
    await schema.pool.query("UPDATE daily_stats SET portfolio_updates = 99 WHERE day = '2026-11-02'");
    await schema.pool.query("DELETE FROM daily_stats WHERE day = '2026-11-05'");
    await schema.pool.query("INSERT INTO daily_stats (day, folders_claimed) VALUES ('2020-01-01', 5)");

    await rebuildDailyStats(client);

    expect(await snapshot()).toEqual(EXPECTED);
  });

  it('counts an indexer page exactly once when a rebuild runs concurrently with it', async () => {
    await ingestAll(FIXTURES.slice(0, 5));
    const indexer = await schema.pool.connect();
    const rebuilder = await schema.pool.connect();
    try {
      // An indexer page has incremented daily_stats but not committed yet.
      const late = fx('2026-11-06T00:00:00Z', claim('GLATE'));
      await indexer.query('BEGIN');
      await indexer.query(
        `INSERT INTO contract_events
           (id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status)
         VALUES ($1, $2, $3, 'tx', 'C', 'folder_cl', '{}', '', $4, 'applied')`,
        [late.id, late.ledger, late.at, JSON.stringify(late.event)]
      );
      await updateCounters(indexer, late.event, new Date(late.at));

      const rebuild = rebuildDailyStats(rebuilder);
      await new Promise((resolve) => setTimeout(resolve, 200)); // rebuild now waits on the lock
      await indexer.query('COMMIT');
      await rebuild;

      const rows = await snapshot();
      expect(rows.find((r) => r.day === '2026-11-06')).toMatchObject({ folders_claimed: 1 });
      const { rows: before } = await schema.pool.query('SELECT COUNT(*)::int AS n FROM daily_stats');
      await rebuildDailyStats(rebuilder);
      expect(await snapshot()).toEqual(rows);
      expect(before[0].n).toBe(rows.length);
    } finally {
      indexer.release();
      rebuilder.release();
    }
  });

  it('serves totals and a zero-filled daily series', async () => {
    await ingestAll(FIXTURES);

    expect(await getTotals(schema.pool)).toEqual({
      foldersClaimed: 3,
      portfoliosMinted: 2,
      portfolioUpdates: 2,
      templatesRegistered: 2,
    });
    const daily = await getDaily(schema.pool, '2026-10-31', '2026-11-05');
    expect(daily.map((d) => [d.day, d.foldersClaimed, d.portfolioUpdates])).toEqual([
      ['2026-10-31', 0, 0],
      ['2026-11-01', 1, 0],
      ['2026-11-02', 0, 2],
      ['2026-11-03', 1, 0],
      ['2026-11-04', 0, 0],
      ['2026-11-05', 1, 0],
    ]);

    const server = await serve({ '/stats': createStatsRoutes({ db: schema.pool }) });
    try {
      const res = await server.get('/stats/daily?from=2026-11-04&to=2026-11-05');
      expect(res.body).toEqual({
        from: '2026-11-04',
        to: '2026-11-05',
        days: [
          {
            day: '2026-11-04',
            foldersClaimed: 0,
            portfoliosMinted: 0,
            portfolioUpdates: 0,
            templatesRegistered: 0,
          },
          {
            day: '2026-11-05',
            foldersClaimed: 1,
            portfoliosMinted: 0,
            portfolioUpdates: 0,
            templatesRegistered: 0,
          },
        ],
      });
    } finally {
      await server.close();
    }
  });
});
