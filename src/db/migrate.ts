import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger';

/**
 * database/schema.sql is the single source of truth for the schema.
 *
 * Resolution order:
 * 1. `SCHEMA_PATH` env override (absolute or relative to cwd).
 * 2. `../../database/schema.sql` relative to this file — works when running
 *    from source via tsx (`src/db/migrate.ts`).
 * 3. `../database/schema.sql` relative to this file — works when bundled into
 *    a single file at the project root (e.g. `dist/indexer.js`).
 */
function resolveSchemaPath(): string {
  const override = process.env.SCHEMA_PATH;
  if (override) {
    return path.resolve(override);
  }
  const candidates = [
    path.resolve(__dirname, '../../database/schema.sql'),
    path.resolve(__dirname, '../database/schema.sql'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export const SCHEMA_PATH = resolveSchemaPath();

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { waitForDatabase } = require('./client');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require('../config/env');
  waitForDatabase(pool, {
    timeoutMs: env.DB_WAIT_TIMEOUT_MS,
    maxDelayMs: env.DB_WAIT_MAX_DELAY_MS,
  })
    .then(() => migrate(pool))
    .then(() => logger.info('Migrations applied'))
    .catch((err) => {
      logger.error('Migration failed', { error: err instanceof Error ? err.message : err });
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
