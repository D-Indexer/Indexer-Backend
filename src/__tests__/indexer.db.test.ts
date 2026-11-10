/**
 * Runs the indexer's DB code against a real Postgres. Skipped unless
 * TEST_DATABASE_URL is set (CI provides one; locally see CONTRIBUTING.md).
 * The database is wiped: point it at a throwaway database.
 */
import { Pool } from 'pg';
import { migrate } from '../db/migrate';
import { GetEventsResult } from '../indexer/rpc';
import { processPage, readState } from '../indexer/stellar';
import { addr, makeEvent, OWNER, str, TESTNET_CONTRACT, testnetEvents, u32 } from './eventFixtures';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

function page(events = testnetEvents, cursor = 'cursor-1'): GetEventsResult {
  return { events, cursor, latestLedger: 5654239, oldestLedger: 5533280 };
}

describeDb('indexer against Postgres', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE contract_events, folders, templates, portfolios, admins, indexer_state'
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function count(table: string): Promise<number> {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    return rows[0].n;
  }

  it('builds the read model from the real testnet events', async () => {
    await processPage(pool, TESTNET_CONTRACT, page());

    const templates = await pool.query('SELECT id, metadata_uri, creator FROM templates ORDER BY id');
    expect(templates.rows.map((r) => Number(r.id))).toEqual([1, 2, 3]);

    const folder = await pool.query('SELECT * FROM folders WHERE owner = $1', [OWNER]);
    expect(folder.rows[0]).toMatchObject({ name: 'smoke-1794262900.folder', template_id: '1' });

    const portfolio = await pool.query('SELECT * FROM portfolios WHERE owner = $1', [OWNER]);
    expect(portfolio.rows[0]).toMatchObject({
      template_id: '1',
      ipfs_cid: 'bafkreifwfa7v77kn2om36djjtqiwqykldpady3ytsfbqkqgcrfilhjqtnu',
    });
    expect(await count('portfolios')).toBe(2);
    expect(await count('admins')).toBe(1);
    expect((await readState(pool)).cursor).toBe('cursor-1');
  });

  it('is idempotent when the same page is processed twice', async () => {
    await processPage(pool, TESTNET_CONTRACT, page());
    const before = await pool.query('SELECT * FROM portfolios ORDER BY owner');

    const second = await processPage(pool, TESTNET_CONTRACT, page(testnetEvents, 'cursor-2'));

    expect(second).toEqual({ applied: 0, ignored: 0, rejected: 0, duplicates: 10 });
    expect(await count('contract_events')).toBe(10);
    expect((await pool.query('SELECT * FROM portfolios ORDER BY owner')).rows).toEqual(before.rows);
    expect((await readState(pool)).cursor).toBe('cursor-2');
  });

  it('leaves no partial writes and keeps the old cursor when a page fails', async () => {
    await processPage(pool, TESTNET_CONTRACT, page(testnetEvents.slice(0, 1), 'before'));

    // Fail on the portfolio insert, after earlier events in the page were written.
    const failing = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql: string, params?: unknown[]) =>
            sql.includes('INSERT INTO portfolios')
              ? Promise.reject(new Error('connection terminated'))
              : client.query(sql, params),
          release: () => client.release(),
        };
      },
      query: pool.query.bind(pool),
    } as unknown as Pool;

    await expect(processPage(failing, TESTNET_CONTRACT, page(testnetEvents.slice(1), 'after'))).rejects.toThrow(
      'connection terminated'
    );

    expect(await count('contract_events')).toBe(1);
    expect(await count('folders')).toBe(0);
    expect((await readState(pool)).cursor).toBe('before');
  });

  it('records rejected events and still advances the cursor', async () => {
    const bad = makeEvent('port_mint', [addr(OWNER), str('not-a-u32'), str('cid')]);
    const result = await processPage(pool, TESTNET_CONTRACT, page([bad], 'past-bad'));

    expect(result.rejected).toBe(1);
    const { rows } = await pool.query('SELECT status, error FROM contract_events');
    expect(rows[0]).toMatchObject({ status: 'rejected', error: expect.stringMatching(/template_id/) });
    expect((await readState(pool)).cursor).toBe('past-bad');
  });

  it('rejects, rather than blocks on, an event that violates a constraint', async () => {
    const other = 'GDWRL5Y2H6N2SD3ZDODU7XST543GZO5AAVGVD3HPK4ZPCCFL4CBKKSWL';
    const first = makeEvent('folder_cl', [addr(OWNER), str('taken.folder')]);
    const clash = makeEvent('folder_cl', [addr(other), str('taken.folder')]);
    const after = makeEvent('tmpl_reg', [u32(9), str('ipfs://x')]);

    const result = await processPage(pool, TESTNET_CONTRACT, page([first, clash, after]));

    expect(result).toMatchObject({ applied: 2, rejected: 1 });
    expect(await count('templates')).toBe(1);
  });

  it('stores the full u32 template id range', async () => {
    await processPage(pool, TESTNET_CONTRACT, page([makeEvent('tmpl_reg', [u32(4294967295), str('ipfs://max')])]));
    const { rows } = await pool.query('SELECT id FROM templates');
    expect(rows[0].id).toBe('4294967295');
  });

  it('applies tmpl_set to the folder and the minted portfolio', async () => {
    await processPage(pool, TESTNET_CONTRACT, page());
    await processPage(pool, TESTNET_CONTRACT, page([makeEvent('tmpl_set', [addr(OWNER), u32(3)])]));

    const { rows } = await pool.query(
      'SELECT f.template_id AS f, p.template_id AS p FROM folders f JOIN portfolios p USING (owner) WHERE owner = $1',
      [OWNER]
    );
    expect(rows[0]).toEqual({ f: '3', p: '3' });
  });

  it('refuses to migrate on top of the legacy schema', async () => {
    await pool.query('ALTER TABLE folders ADD COLUMN cid TEXT');
    await expect(migrate(pool)).rejects.toThrow(/Legacy schema detected/);
    await pool.query('ALTER TABLE folders DROP COLUMN cid');
  });
});
