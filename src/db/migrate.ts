import 'dotenv/config';
import { readFileSync } from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger';

/** database/schema.sql is the single source of truth for the schema. */
export const SCHEMA_PATH = path.resolve(__dirname, '../../database/schema.sql');

export function loadSchemaSql(schemaPath = SCHEMA_PATH): string {
  return readFileSync(schemaPath, 'utf8');
}

/**
 * The pre-testnet schema had `folders.cid` and a `credentials` table that no
 * contract event populates. Refuse to run on top of it rather than silently
 * mixing the two layouts.
 */
export async function assertNoLegacySchema(db: Pick<Pool, 'query'>): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'folders' AND column_name = 'cid'`
  );
  if (rows.length > 0) {
    throw new Error(
      'Legacy schema detected (folders.cid). The previous indexer could not decode the deployed ' +
        'contract, so these tables hold no indexed data. Drop them and re-run the migration: ' +
        'DROP TABLE IF EXISTS credentials, folders, templates, indexer_state CASCADE; ' +
        '(see docs/operations.md)'
    );
  }
}

export async function migrate(db: Pick<Pool, 'query'>): Promise<void> {
  await assertNoLegacySchema(db);
  await db.query(loadSchemaSql());
}

if (require.main === module) {
  // Imported lazily so loading this module (e.g. in tests) doesn't need env.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pool: Pool = require('./client').default;
  migrate(pool)
    .then(() => logger.info('Migrations applied'))
    .catch((err) => {
      logger.error('Migration failed', { error: err instanceof Error ? err.message : err });
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
