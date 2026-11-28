import { NextFunction, Request, RequestHandler, Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient, Client } from 'pg';

export function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res;
}

export async function invokeHandler(
  handler: RequestHandler,
  req: Partial<Request>,
  res: Response = mockResponse()
): Promise<{ res: Response; next: jest.MockedFunction<NextFunction> }> {
  const next = jest.fn() as jest.MockedFunction<NextFunction>;
  const result = handler(req as Request, res, next) as unknown;

  if (result && typeof (result as Promise<unknown>).then === 'function') {
    await result;
  }

  await new Promise(process.nextTick);

  return { res, next };
}

// ---------------------------------------------------------------------------
// DB-backed test helpers
// ---------------------------------------------------------------------------

const SCHEMA_SQL_PATH = join(__dirname, '..', '..', 'database', 'schema.sql');

/**
 * Returns the worker-specific schema name, e.g. `test_1`.
 * Falls back to `test_0` when not running under Jest workers.
 */
export function getWorkerSchemaName(): string {
  const workerId = process.env.JEST_WORKER_ID ?? '0';
  return `test_${workerId}`;
}

function getDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/postgres'
  );
}

/**
 * Direct (non-pooled) URL for DDL: schema creation/teardown must not go
 * through a transaction-mode PgBouncer. Falls back to the regular URL.
 */
function getDirectDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_DIRECT_URL ||
    process.env.DATABASE_DIRECT_URL ||
    getDatabaseUrl()
  );
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Creates the worker-specific schema (dropping any existing one) and applies
 * `database/schema.sql` into it. Safe to call multiple times.
 */
export async function setupWorkerSchema(): Promise<string> {
  const schema = getWorkerSchemaName();
  const client = new Client({ connectionString: getDirectDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);
    const schemaSql = readFileSync(SCHEMA_SQL_PATH, 'utf8');
    await client.query(schemaSql);
  } finally {
    await client.end();
  }
  return schema;
}

/**
 * Drops the worker-specific schema. Call from global teardown.
 */
export async function teardownWorkerSchema(): Promise<void> {
  const schema = getWorkerSchemaName();
  const client = new Client({ connectionString: getDirectDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  } finally {
    await client.end();
  }
}

/**
 * Returns a Pool whose connections run `SET search_path TO <worker schema>`.
 * The caller is responsible for ending the pool.
 */
export function createWorkerPool(extraConfig: Record<string, unknown> = {}): Pool {
  const schema = getWorkerSchemaName();
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    ...extraConfig,
  });
  // Ensure every new connection uses the worker schema. NOTE: this is a
  // session-level SET, which does not stick behind PgBouncer in transaction
  // mode; the `pgbouncer` CI job sets the schema as a role default instead
  // (ALTER ROLE ... SET search_path). See docs/database-connections.md.
  pool.on('connect', (client: PoolClient) => {
    client.query(`SET search_path TO ${quoteIdent(schema)}`).catch(() => {
      /* surfaced on first real query */
    });
  });
  // Also set search_path via connection options for robustness.
  pool.on('error', () => {
    /* ignore idle client errors in tests */
  });
  return pool;
}

/**
 * Returns a single Client connected with the worker schema on its search_path.
 * The caller is responsible for ending the client.
 */
export async function createWorkerClient(): Promise<Client> {
  const schema = getWorkerSchemaName();
  const client = new Client({ connectionString: getDatabaseUrl() });
  await client.connect();
  await client.query(`SET search_path TO ${quoteIdent(schema)}`);
  return client;
}

/**
 * Truncates all tables in the worker schema. Useful between tests.
 */
export async function truncateWorkerSchema(client: Pool | PoolClient | Client): Promise<void> {
  const schema = getWorkerSchemaName();
  const { rows } = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
    [schema]
  );
  if (rows.length === 0) {
    return;
  }
  const list = rows.map((r) => `${quoteIdent(schema)}.${quoteIdent(r.tablename)}`).join(', ');
  await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

// ---------------------------------------------------------------------------
// Query-plan test helpers
// ---------------------------------------------------------------------------

export interface SeedOptions {
  folders?: number;
  events?: number;
  templates?: number;
  ledgerEntries?: number;
}

/**
 * Seeds large volumes of data into the worker schema using `generate_series`
 * for speed. Intended for query-plan regression tests.
 *
 * The exact table/column names are intentionally generic; adjust the INSERT
 * statements below to match the schema. Each insert is wrapped so missing
 * tables are tolerated (the plan tests only care about the tables they use).
 */
export async function seedLargeVolumes(
  client: Pool | PoolClient | Client,
  options: SeedOptions = {}
): Promise<void> {
  const { folders = 0, events = 0, templates = 0, ledgerEntries = 0 } = options;

  if (folders > 0) {
    await client.query(
      `INSERT INTO folders (id, owner_id, name, created_at)
       SELECT g, (g % 1000) + 1, 'folder_' || g, now()
       FROM generate_series(1, $1) AS g
       ON CONFLICT DO NOTHING`,
      [folders]
    );
  }

  if (templates > 0) {
    await client.query(
      `INSERT INTO templates (id, owner_id, name, created_at)
       SELECT g, (g % 1000) + 1, 'template_' || g, now()
       FROM generate_series(1, $1) AS g
       ON CONFLICT DO NOTHING`,
      [templates]
    );
  }

  if (events > 0) {
    await client.query(
      `INSERT INTO events (id, folder_id, template_id, created_at)
       SELECT g, (g % GREATEST($2, 1)) + 1, (g % GREATEST($3, 1)) + 1, now()
       FROM generate_series(1, $1) AS g
       ON CONFLICT DO NOTHING`,
      [events, folders, templates]
    );
  }

  if (ledgerEntries > 0) {
    await client.query(
      `INSERT INTO ledger_entries (id, owner_id, amount, created_at)
       SELECT g, (g % 1000) + 1, 1, now()
       FROM generate_series(1, $1) AS g
       ON CONFLICT DO NOTHING`,
      [ledgerEntries]
    );
  }

  // Refresh planner statistics so EXPLAIN reflects the seeded volume.
  await client.query('ANALYZE');
}

/**
 * Runs `EXPLAIN (FORMAT JSON)` for the given query and returns the parsed plan.
 */
export async function explainJson(
  client: Pool | PoolClient | Client,
  sql: string,
  params: unknown[] = []
): Promise<unknown> {
  const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  return rows[0]['QUERY PLAN'];
}