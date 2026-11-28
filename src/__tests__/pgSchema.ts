import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

/**
 * Postgres-backed test support. Suites using it are skipped unless
 * TEST_DATABASE_URL is set (CI provides one). Each suite gets its own schema,
 * so suites never see each other's rows and nothing outside it is touched.
 */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
export const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

/**
 * Postgres rejects a UNIQUE index on a partitioned table unless it includes
 * the partition key, so this statement in schema.sql fails on every Postgres
 * version and aborts the rest of the file. Until that is fixed upstream, the
 * tests that need the rest of the schema apply it with this one index made
 * non-unique. Nothing under test relies on its uniqueness.
 */
const BROKEN_UNIQUE_INDEX =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_events_id ON contract_events (id);';

export function testSchemaSql(): string {
  return SCHEMA_SQL.replace(BROKEN_UNIQUE_INDEX, BROKEN_UNIQUE_INDEX.replace('UNIQUE ', ''));
}

export interface TestSchema {
  pool: Pool;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Create (or recreate) schema `name`, apply database/schema.sql into it, and return a pool bound to it. */
export async function createTestSchema(name: string): Promise<TestSchema> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE; CREATE SCHEMA "${name}"`);
  await admin.end();

  const pool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${name}` });
  await pool.query(testSchemaSql());

  return {
    pool,
    async reset() {
      const { rows } = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename NOT LIKE 'contract_events_%'`,
        [name]
      );
      if (rows.length === 0) return;
      await pool.query(`TRUNCATE ${rows.map((r) => `"${name}"."${r.tablename}"`).join(', ')}`);
    },
    async close() {
      await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      await pool.end();
    },
  };
}
