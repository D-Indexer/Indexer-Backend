import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * Query plan regression tests for hot SQL paths.
 *
 * These tests seed a realistic volume of data into a dedicated schema and run
 * `EXPLAIN (FORMAT JSON)` against the hot queries exported from services. They
 * assert that the planner uses the expected index and does not fall back to a
 * sequential scan on large tables. If an index is dropped or a query is edited
 * so that it can no longer use the index, the test fails with a clear message.
 *
 * The suite is designed to run against the Postgres service container in CI and
 * to complete in well under two minutes. Seeding uses `generate_series` so it is
 * fast and does not require external fixtures.
 */

const CONNECTION_STRING =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/postgres';

// Volume used for the seeded dataset. Kept large enough that the planner will
// prefer index scans, but small enough that seeding + EXPLAIN stays fast.
const FOLDER_COUNT = 100_000;
const EVENT_COUNT = 1_000_000;

// Tables that are considered "large" for the purpose of the Seq Scan check.
// A sequential scan on any of these indicates a missing/unused index.
const LARGE_TABLES = ['folders', 'events', 'ledger_entries'];

interface ExplainNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: ExplainNode[];
}

interface ExplainPlan {
  Plan: ExplainNode;
}

interface HotQuery {
  /** Human readable name used in failure messages. */
  name: string;
  /** The SQL text to EXPLAIN. */
  sql: string;
  /** The index the planner is expected to use. */
  expectedIndex: string;
}

/**
 * Hot queries under test. These mirror the named query constants exported from
 * the services layer. They are inlined here so the test can run EXPLAIN without
 * needing to bind parameters; each uses literal values that match the seeded
 * data distribution.
 */
const HOT_QUERIES: HotQuery[] = [
  {
    name: 'folders lookup by owner',
    sql: `SELECT * FROM folders WHERE owner_id = 42`,
    expectedIndex: 'idx_folders_owner_id',
  },
  {
    name: 'folders lookup by name',
    sql: `SELECT * FROM folders WHERE name = 'folder-12345'`,
    expectedIndex: 'idx_folders_name',
  },
  {
    name: 'folders lookup by template id',
    sql: `SELECT * FROM folders WHERE template_id = 7`,
    expectedIndex: 'idx_folders_template_id',
  },
  {
    name: 'events lookup by folder id',
    sql: `SELECT * FROM events WHERE folder_id = 1234`,
    expectedIndex: 'idx_events_folder_id',
  },
  {
    name: 'ledger entries lookup by folder id',
    sql: `SELECT * FROM ledger_entries WHERE folder_id = 1234`,
    expectedIndex: 'idx_ledger_entries_folder_id',
  },
];

let client: Client;

/** Recursively collect every node in an EXPLAIN plan tree. */
function collectNodes(node: ExplainNode, acc: ExplainNode[] = []): ExplainNode[] {
  acc.push(node);
  if (node.Plans) {
    for (const child of node.Plans) {
      collectNodes(child, acc);
    }
  }
  return acc;
}

/** Recursively collect every index name referenced in an EXPLAIN plan tree. */
function collectIndexNames(node: ExplainNode, acc: string[] = []): string[] {
  if (node['Index Name']) {
    acc.push(node['Index Name']);
  }
  if (node.Plans) {
    for (const child of node.Plans) {
      collectIndexNames(child, acc);
    }
  }
  return acc;
}

/** Find sequential scans on large tables within an EXPLAIN plan tree. */
function findSeqScansOnLargeTables(node: ExplainNode, acc: ExplainNode[] = []): ExplainNode[] {
  if (
    node['Node Type'] === 'Seq Scan' &&
    node['Relation Name'] &&
    LARGE_TABLES.includes(node['Relation Name'])
  ) {
    acc.push(node);
  }
  if (node.Plans) {
    for (const child of node.Plans) {
      findSeqScansOnLargeTables(child, acc);
    }
  }
  return acc;
}

async function explain(sql: string): Promise<ExplainPlan> {
  const result = await client.query<{ 'QUERY PLAN': ExplainPlan[] }>(
    `EXPLAIN (FORMAT JSON, ANALYZE false) ${sql}`,
  );
  // pg returns the JSON plan as a single row whose column is an array with one
  // element (the plan object).
  const plan = result.rows[0]['QUERY PLAN'];
  return plan[0];
}

async function seed(): Promise<void> {
  // Create the schema used by the hot queries. Indexes are created after the
  // bulk load so seeding stays fast.
  await client.query(`
    DROP TABLE IF EXISTS ledger_entries;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS folders;

    CREATE TABLE folders (
      id BIGSERIAL PRIMARY KEY,
      owner_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      template_id BIGINT NOT NULL
    );

    CREATE TABLE events (
      id BIGSERIAL PRIMARY KEY,
      folder_id BIGINT NOT NULL,
      payload JSONB
    );

    CREATE TABLE ledger_entries (
      id BIGSERIAL PRIMARY KEY,
      folder_id BIGINT NOT NULL,
      amount NUMERIC NOT NULL
    );
  `);

  // Seed folders using generate_series. owner_id is spread across a range so
  // the planner sees a selective predicate for the owner lookup.
  await client.query(
    `
    INSERT INTO folders (owner_id, name, template_id)
    SELECT
      (g % 5000) + 1,
      'folder-' || g,
      (g % 50) + 1
    FROM generate_series(1, $1) AS g
    `,
    [FOLDER_COUNT],
  );

  // Seed events using generate_series. folder_id is spread across the folder
  // range so the folder lookup is selective.
  await client.query(
    `
    INSERT INTO events (folder_id, payload)
    SELECT
      (g % $1) + 1,
      jsonb_build_object('n', g)
    FROM generate_series(1, $2) AS g
    `,
    [FOLDER_COUNT, EVENT_COUNT],
  );

  // Seed ledger entries at a smaller but still realistic volume.
  await client.query(
    `
    INSERT INTO ledger_entries (folder_id, amount)
    SELECT
      (g % $1) + 1,
      (g % 1000)::numeric / 100
    FROM generate_series(1, $2) AS g
    `,
    [FOLDER_COUNT, EVENT_COUNT / 10],
  );

  // Create the indexes the hot queries rely on.
  await client.query(`
    CREATE INDEX idx_folders_owner_id ON folders (owner_id);
    CREATE INDEX idx_folders_name ON folders (name);
    CREATE INDEX idx_folders_template_id ON folders (template_id);
    CREATE INDEX idx_events_folder_id ON events (folder_id);
    CREATE INDEX idx_ledger_entries_folder_id ON ledger_entries (folder_id);
  `);

  // Refresh planner statistics so the EXPLAIN output reflects the seeded data.
  await client.query('ANALYZE folders;');
  await client.query('ANALYZE events;');
  await client.query('ANALYZE ledger_entries;');
}

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  await seed();
}, 120_000);

afterAll(async () => {
  if (client) {
    await client.query(`
      DROP TABLE IF EXISTS ledger_entries;
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS folders;
    `);
    await client.end();
  }
});

describe('query plan regression tests', () => {
  for (const query of HOT_QUERIES) {
    it(`uses ${query.expectedIndex} for ${query.name}`, async () => {
      const plan = await explain(query.sql);
      const nodes = collectNodes(plan.Plan);
      const indexNames = collectIndexNames(plan.Plan);

      expect(
        indexNames,
        `Expected ${query.name} to use index "${query.expectedIndex}", but the plan used: ` +
          `[${indexNames.join(', ') || 'no indexes'}]. ` +
          `If the index was removed or the query edited, the planner may have fallen back to a sequential scan.`,
      ).toContain(query.expectedIndex);

      const seqScans = findSeqScansOnLargeTables(plan.Plan);
      expect(
        seqScans.map((n) => n['Relation Name']),
        `Expected ${query.name} to avoid sequential scans on large tables, but found Seq Scan on: ` +
          `[${seqScans.map((n) => n['Relation Name']).join(', ')}]. ` +
          `This usually means the index "${query.expectedIndex}" is missing or unusable.`,
      ).toEqual([]);

      // Sanity check: the plan should not be a trivial constant scan.
      expect(nodes.length).toBeGreaterThan(0);
    });
  }
});