import { decodeCursor } from '../http/pagination';
import { createCreatorRoutes } from '../routes/creator.routes';
import { getCreatorStats, listTemplatesByCreator } from '../services/template';
import { serve } from './httpHarness';
import { createTestSchema, describeDb, type TestSchema } from './pgSchema';

const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOB = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const NOBODY = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

describeDb('creators against Postgres', () => {
  let schema: TestSchema;

  async function template(id: number, creator: string | null, registeredAt: string, usage = 0) {
    await schema.pool.query(
      'INSERT INTO templates (id, metadata_uri, creator, registered_at) VALUES ($1, $2, $3, $4)',
      [id, `ipfs://t${id}`, creator, registeredAt]
    );
    if (usage) {
      await schema.pool.query('INSERT INTO template_usage (template_id, portfolio_count) VALUES ($1, $2)', [
        id,
        usage,
      ]);
    }
  }

  async function allPages(creator: string, limit: number): Promise<number[]> {
    const ids: number[] = [];
    let after: string[] | null = null;
    for (let i = 0; i < 20; i++) {
      const page = await listTemplatesByCreator(schema.pool, creator, { limit, after });
      ids.push(...page.items.map((t) => t.id));
      if (!page.nextCursor) return ids;
      after = decodeCursor(page.nextCursor, 2);
    }
    throw new Error('pagination did not terminate');
  }

  beforeAll(async () => {
    schema = await createTestSchema('test_creators');
  });
  beforeEach(async () => {
    await schema.reset();
    // Mixed creators, null creators (pre-creator contract versions), and ties
    // on registered_at that only the id tiebreak can order.
    await template(10, ALICE, '2026-11-03T00:00:00Z', 4);
    await template(3, ALICE, '2026-11-01T00:00:00Z', 1);
    await template(7, ALICE, '2026-11-02T00:00:00Z');
    await template(5, ALICE, '2026-11-02T00:00:00Z', 2);
    await template(6, ALICE, '2026-11-02T00:00:00.000001Z');
    await template(1, BOB, '2026-11-01T00:00:00Z', 9);
    await template(2, null, '2026-11-01T00:00:00Z', 5);
    await template(4, null, '2026-11-02T00:00:00Z');
  });
  afterAll(() => schema.close());

  it("returns only that creator's templates in a stable (registered_at, id) order", async () => {
    expect(await allPages(ALICE, 100)).toEqual([3, 5, 7, 6, 10]);
    expect(await allPages(BOB, 100)).toEqual([1]);
  });

  it.each([1, 2, 3])('pages through with limit %i without gaps or duplicates', async (limit) => {
    expect(await allPages(ALICE, limit)).toEqual([3, 5, 7, 6, 10]);
  });

  it('never attributes null-creator templates and returns empty results for unknown creators', async () => {
    expect(await allPages(NOBODY, 10)).toEqual([]);
    expect(await getCreatorStats(schema.pool, NOBODY)).toEqual({
      address: NOBODY,
      templateCount: 0,
      totalUsage: 0,
    });
  });

  it('aggregates template count and total usage per creator', async () => {
    expect(await getCreatorStats(schema.pool, ALICE)).toEqual({
      address: ALICE,
      templateCount: 5,
      totalUsage: 7,
    });
    expect(await getCreatorStats(schema.pool, BOB)).toEqual({
      address: BOB,
      templateCount: 1,
      totalUsage: 9,
    });
  });

  it('serves both endpoints over HTTP', async () => {
    const server = await serve({ '/creators': createCreatorRoutes({ db: schema.pool }) });
    try {
      const stats = await server.get(`/creators/${ALICE}`);
      expect(stats.body).toEqual({ address: ALICE, templateCount: 5, totalUsage: 7 });

      const first = await server.get(`/creators/${ALICE}/templates?limit=2`);
      const body = first.body as { templates: { id: number; usageCount: number }[]; nextCursor: string };
      expect(body.templates.map((t) => [t.id, t.usageCount])).toEqual([
        [3, 1],
        [5, 2],
      ]);
      const second = await server.get(`/creators/${ALICE}/templates?limit=2&cursor=${body.nextCursor}`);
      expect((second.body as { templates: { id: number }[] }).templates.map((t) => t.id)).toEqual([7, 6]);

      const unknown = await server.get(`/creators/${NOBODY}/templates`);
      expect(unknown.status).toBe(200);
      expect(unknown.body).toEqual({ templates: [], nextCursor: null });
    } finally {
      await server.close();
    }
  });

  it('uses the (creator, registered_at, id) index for the listing', async () => {
    await schema.pool.query('ANALYZE templates');
    await schema.pool.query('SET enable_seqscan = off');
    try {
      const { rows } = await schema.pool.query(
        `EXPLAIN SELECT id FROM templates WHERE creator = $1 ORDER BY registered_at, id LIMIT 21`,
        [ALICE]
      );
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('idx_templates_creator_registered');
    } finally {
      await schema.pool.query('RESET enable_seqscan');
    }
  });
});
