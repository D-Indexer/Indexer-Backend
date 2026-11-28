import type { PoolClient } from 'pg';
import type { DecodedEvent } from '../indexer/decode';
import { updateCounters } from '../indexer/counters';
import type { Queryable } from '../db/types';
import { getTemplate, listTemplatePortfolios, listTemplates } from '../services/template';
import { decodeCursor } from '../http/pagination';
import { createTestSchema, describeDb, testSchemaSql, type TestSchema } from './pgSchema';

const A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

/**
 * Applies the counter update and then the portfolio write the indexer handler
 * makes for the same event, in the same order and transaction as applyEvent.
 * (The handler itself can't run here: its other statements target columns
 * that database/schema.sql doesn't define yet.)
 */
async function apply(db: Queryable, event: DecodedEvent, at: string): Promise<void> {
  await db.query('BEGIN');
  await updateCounters(db, event);
  if (event.topic === 'port_mint') {
    await db.query(
      `INSERT INTO portfolios (owner, template_id, ipfs_cid, minted_at, updated_at) VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (owner) DO UPDATE SET template_id = EXCLUDED.template_id, updated_at = EXCLUDED.updated_at`,
      [event.owner, event.templateId, event.ipfsCid, at]
    );
  } else if (event.topic === 'tmpl_set') {
    await db.query('UPDATE portfolios SET template_id = $2, updated_at = $3 WHERE owner = $1', [
      event.owner,
      event.templateId,
      at,
    ]);
  }
  await db.query('COMMIT');
}

const mint = (owner: string, templateId: number): DecodedEvent => ({
  topic: 'port_mint',
  owner,
  templateId,
  ipfsCid: 'bafkcid',
});
const set = (owner: string, templateId: number): DecodedEvent => ({ topic: 'tmpl_set', owner, templateId });

describeDb('template usage against Postgres', () => {
  let schema: TestSchema;
  let db: PoolClient;

  async function usage(): Promise<Record<number, number>> {
    const { rows } = await schema.pool.query(
      'SELECT template_id, portfolio_count FROM template_usage WHERE portfolio_count > 0 ORDER BY template_id'
    );
    return Object.fromEntries(rows.map((r) => [Number(r.template_id), Number(r.portfolio_count)]));
  }

  async function aggregate(): Promise<Record<number, number>> {
    const { rows } = await schema.pool.query(
      'SELECT template_id, COUNT(*) AS n FROM portfolios GROUP BY template_id ORDER BY template_id'
    );
    return Object.fromEntries(rows.map((r) => [Number(r.template_id), Number(r.n)]));
  }

  beforeAll(async () => {
    schema = await createTestSchema('test_template_usage');
  });
  beforeEach(async () => {
    await schema.reset();
    db = await schema.pool.connect();
    for (const id of [1, 2, 3]) {
      await schema.pool.query(
        `INSERT INTO templates (id, metadata_uri, creator, registered_at) VALUES ($1, $2, NULL, NOW())`,
        [id, `ipfs://t${id}`]
      );
    }
  });
  afterEach(() => db.release());
  afterAll(() => schema.close());

  it('counts mints, moves portfolios on tmpl_set, and ignores tmpl_set without a portfolio', async () => {
    await apply(db, mint(A, 1), '2026-11-01T00:00:00Z');
    await apply(db, mint(B, 1), '2026-11-01T00:00:01Z');
    await apply(db, mint(C, 2), '2026-11-01T00:00:02Z');
    expect(await usage()).toEqual({ 1: 2, 2: 1 });

    await apply(db, set(A, 2), '2026-11-01T00:00:03Z'); // move A: 1 -> 2
    await apply(db, set(B, 1), '2026-11-01T00:00:04Z'); // same template: no-op
    await apply(db, set('GNOPORTFOLIO', 3), '2026-11-01T00:00:05Z'); // folder only
    await apply(db, mint(C, 3), '2026-11-01T00:00:06Z'); // re-mint over existing moves it
    expect(await usage()).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(await usage()).toEqual(await aggregate());
  });

  it('exposes usageCount and sorts by popularity', async () => {
    await apply(db, mint(A, 3), '2026-11-01T00:00:00Z');
    await apply(db, mint(B, 3), '2026-11-01T00:00:01Z');
    await apply(db, mint(C, 2), '2026-11-01T00:00:02Z');

    expect((await getTemplate(schema.pool, 3))?.usageCount).toBe(2);
    expect((await getTemplate(schema.pool, 1))?.usageCount).toBe(0);
    expect((await listTemplates(schema.pool, 'popular')).map((t) => [t.id, t.usageCount])).toEqual([
      [3, 2],
      [2, 1],
      [1, 0],
    ]);
    expect((await listTemplates(schema.pool)).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('paginates a template portfolios newest first without gaps or overlaps across timestamp ties', async () => {
    const owners = Array.from({ length: 7 }, (_, i) => `G${String(i).padStart(55, 'X')}`);
    // Two groups share a timestamp so the owner tiebreak is exercised; the
    // microsecond timestamp checks the cursor round-trips exact precision.
    const times = [
      '2026-11-01T00:00:00Z',
      '2026-11-01T00:00:00Z',
      '2026-11-01T00:00:00Z',
      '2026-11-01T00:00:00.123456Z',
      '2026-11-01T00:00:00.123456Z',
      '2026-11-02T00:00:00Z',
      '2026-11-03T00:00:00Z',
    ];
    for (const [i, owner] of owners.entries()) await apply(db, mint(owner, 1), times[i] as string);
    await apply(db, mint(A, 2), '2026-11-04T00:00:00Z'); // other template: excluded

    const seen: string[] = [];
    let after: string[] | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const page = await listTemplatePortfolios(schema.pool, 1, { limit: 3, after });
      seen.push(...page.items.map((p) => p.owner));
      if (!page.nextCursor) break;
      after = decodeCursor(page.nextCursor, 2);
    }

    const { rows } = await schema.pool.query(
      'SELECT owner FROM portfolios WHERE template_id = 1 ORDER BY updated_at DESC, owner DESC'
    );
    expect(seen).toEqual(rows.map((r) => r.owner));
    expect(new Set(seen).size).toBe(7);
  });

  it('backfills template_usage from portfolios when the table is first created, and only then', async () => {
    await schema.pool.query(
      `INSERT INTO portfolios (owner, template_id, ipfs_cid, minted_at, updated_at)
       VALUES ($1, 1, 'c', NOW(), NOW()), ($2, 1, 'c', NOW(), NOW()), ($3, 2, 'c', NOW(), NOW())`,
      [A, B, C]
    );
    // Simulate upgrading a database that predates the counter table.
    await schema.pool.query('DROP TABLE template_usage');
    await schema.pool.query(testSchemaSql());
    expect(await usage()).toEqual({ 1: 2, 2: 1 });

    // Re-running the migration must not recompute (and race) live counters.
    await schema.pool.query('UPDATE template_usage SET portfolio_count = 42 WHERE template_id = 1');
    await schema.pool.query(testSchemaSql());
    expect((await usage())[1]).toBe(42);
  });
});
