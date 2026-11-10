/**
 * Live integration test: runs the real indexer against the deployed testnet
 * contract and checks that what the contract's smoke script created
 * (Indexer-Contract scripts/smoke-testnet.sh) ends up in Postgres.
 *
 * Skipped unless TESTNET_INTEGRATION=1 and TEST_DATABASE_URL are set. The
 * nightly workflow (.github/workflows/nightly-testnet.yml) runs a fresh smoke
 * script first and passes:
 *   SMOKE_START_LEDGER  ledger to start indexing from (just before the smoke run)
 *   SMOKE_OWNER         account the smoke script created
 *   SMOKE_FOLDER        folder name it claimed
 * Without them the test checks the smoke run recorded in Indexer-Contract
 * docs/EVENTS.md, which only works while the RPC still retains those ledgers.
 */
import { Pool } from 'pg';
import { TESTNET_CONTRACT_ID, TESTNET_RPC_URL } from '../config/env';
import { migrate } from '../db/migrate';
import { createRpcClient } from '../indexer/rpc';
import { pollOnce } from '../indexer/stellar';

const enabled = process.env.TESTNET_INTEGRATION === '1' && !!process.env.TEST_DATABASE_URL;
const describeLive = enabled ? describe : describe.skip;

/** From Indexer-Contract deployments/testnet.json and docs/EVENTS.md. */
const DEPLOYMENT = {
  firstLedger: 5647760,
  templatesRegisteredBy: 5647774,
  templates: [1, 2, 3],
  smoke: { owner: 'GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM', folder: 'smoke-1794262900.folder', ledger: 5647861 },
};

const contractId = process.env.FOLDER_CONTRACT_ID || TESTNET_CONTRACT_ID;
const rpcUrl = process.env.STELLAR_RPC_URL || TESTNET_RPC_URL;

describeLive('testnet integration', () => {
  jest.setTimeout(10 * 60 * 1000);

  let pool: Pool;
  const rpc = createRpcClient({ url: rpcUrl, timeoutMs: 20000 });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('indexes the smoke run into Postgres', async () => {
    const { oldestLedger, latestLedger } = await rpc.getHealth();
    const fresh = process.env.SMOKE_OWNER && process.env.SMOKE_FOLDER;
    const expected = fresh
      ? { owner: process.env.SMOKE_OWNER!, folder: process.env.SMOKE_FOLDER! }
      : DEPLOYMENT.smoke;

    const requestedStart = fresh ? Number(process.env.SMOKE_START_LEDGER) || oldestLedger : DEPLOYMENT.firstLedger;
    if (!fresh && requestedStart < oldestLedger) {
      throw new Error(
        `The recorded smoke run (ledger ${DEPLOYMENT.smoke.ledger}) is no longer retained by the RPC ` +
          `(oldest ledger ${oldestLedger}). Run Indexer-Contract scripts/smoke-testnet.sh and pass ` +
          'SMOKE_START_LEDGER, SMOKE_OWNER and SMOKE_FOLDER.'
      );
    }
    const startLedger = Math.max(requestedStart, oldestLedger);

    // Index from startLedger until we reach the ledger the RPC reported up front.
    const config = {
      contractId,
      pollIntervalMs: 0,
      pageLimit: 1000,
      startLedger,
      onRetentionGap: 'halt' as const,
      maxBackoffMs: 0,
    };
    for (let page = 0; page < 500; page++) {
      await pollOnce({ db: pool, rpc, config });
      const { rows } = await pool.query("SELECT value FROM indexer_state WHERE key = 'last_ledger'");
      if (Number(rows[0]?.value) >= latestLedger) break;
    }

    // Every event the live contract emitted decoded cleanly.
    const rejected = await pool.query("SELECT id, topic, error FROM contract_events WHERE status <> 'applied'");
    expect(rejected.rows).toEqual([]);

    // folder_cl -> folders
    const folder = await pool.query('SELECT name FROM folders WHERE owner = $1', [expected.owner]);
    expect(folder.rows).toEqual([{ name: expected.folder }]);

    // port_mint + port_upd -> portfolios, holding the CID from the update.
    const events = await pool.query(
      "SELECT topic, data FROM contract_events WHERE data->>'owner' = $1 ORDER BY id",
      [expected.owner]
    );
    expect(events.rows.map((r) => r.topic)).toEqual(['folder_cl', 'port_mint', 'port_upd']);
    const [, mint, update] = events.rows.map((r) => r.data);

    const portfolio = await pool.query('SELECT template_id, ipfs_cid FROM portfolios WHERE owner = $1', [
      expected.owner,
    ]);
    expect(portfolio.rows).toEqual([{ template_id: String(mint.templateId), ipfs_cid: update.ipfsCid }]);
    expect(update.ipfsCid).not.toBe(mint.ipfsCid);

    // tmpl_reg -> templates (only checkable while the registration ledgers are retained).
    if (startLedger <= DEPLOYMENT.firstLedger) {
      const templates = await pool.query('SELECT id FROM templates ORDER BY id');
      expect(templates.rows.map((r) => Number(r.id))).toEqual(DEPLOYMENT.templates);
    } else {
      console.warn(
        `templates not asserted: registration ledgers (<= ${DEPLOYMENT.templatesRegisteredBy}) ` +
          `are before the indexed range (from ${startLedger})`
      );
    }
  });
});
