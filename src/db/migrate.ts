import 'dotenv/config';
import pool from './client';
import { logger } from '../utils/logger';

export const migrationSql = `
CREATE TABLE IF NOT EXISTS folders (
  owner       TEXT PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  cid         TEXT NOT NULL,
  template_id INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credentials (
  id          SERIAL PRIMARY KEY,
  owner       TEXT NOT NULL REFERENCES folders(owner),
  platform    TEXT NOT NULL,
  proof_hash  TEXT NOT NULL,
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner, platform)
);

CREATE INDEX IF NOT EXISTS idx_credentials_owner_linked_at
  ON credentials (owner, linked_at DESC);

CREATE TABLE IF NOT EXISTS templates (
  id           SERIAL PRIMARY KEY,
  metadata_cid TEXT NOT NULL,
  deprecated   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS indexer_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export async function migrate(): Promise<void> {
  await pool.query(migrationSql);
}

if (require.main === module) {
  migrate()
    .then(() => {
      logger.info('Migrations applied');
    })
    .catch((err) => {
      logger.error('Migration failed', { error: err instanceof Error ? err.message : err });
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
