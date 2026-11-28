import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient, QueryResult } from 'pg';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic for a given seed.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(public readonly seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    // inclusive min, exclusive max
    return min + Math.floor(this.next() * (max - min));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length)];
  }
  shuffle<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Domain types (mirrors the indexer's event encodings).
// ---------------------------------------------------------------------------
type EventKind =
  | 'folder_created'
  | 'folder_renamed'
  | 'template_created'
  | 'template_updated'
  | 'portfolio_created'
  | 'portfolio_updated'
  | 'admin_added'
  | 'admin_removed';

interface ChainEvent {
  ledger: number;
  txHash: string;
  kind: EventKind;
  payload: Record<string, unknown>;
}

interface EventPage {
  events: ChainEvent[];
  cursor: string | null;
}

class LedgerRangeError extends Error {
  constructor(public readonly from: number, public readonly to: number) {
    super(`ledger range ${from}..${to} outside retention window`);
    this.name = 'LedgerRangeError';
  }
}

// ---------------------------------------------------------------------------
// Fake chain: generates a random but valid event history.
// ---------------------------------------------------------------------------
function makeEvent(rng: Rng, ledger: number, state: SimState): ChainEvent {
  const kind = rng.pick<EventKind>([
    'folder_created',
    'folder_renamed',
    'template_created',
    'template_updated',
    'portfolio_created',
    'portfolio_updated',
    'admin_added',
    'admin_removed',
  ]);

  const txHash = `tx_${ledger}_${rng.int(0, 1_000_000).toString(16)}`;
  let payload: Record<string, unknown> = {};

  switch (kind) {
    case 'folder_created': {
      const id = `folder_${state.folderSeq++}`;
      state.folders.add(id);
      payload = { id, name: `Folder ${id}` };
      break;
    }
    case 'folder_renamed': {
      const ids = [...state.folders];
      if (ids.length === 0) {
        const id = `folder_${state.folderSeq++}`;
        state.folders.add(id);
        payload = { id, name: `Folder ${id}` };
      } else {
        const id = rng.pick(ids);
        payload = { id, name: `Renamed ${rng.int(0, 1000)}` };
      }
      break;
    }
    case 'template_created': {
      const id = `template_${state.templateSeq++}`;
      state.templates.add(id);
      payload = { id, name: `Template ${id}`, body: '{}' };
      break;
    }
    case 'template_updated': {
      const ids = [...state.templates];
      if (ids.length === 0) {
        const id = `template_${state.templateSeq++}`;
        state.templates.add(id);
        payload = { id, name: `Template ${id}`, body: '{}' };
      } else {
        const id = rng.pick(ids);
        payload = { id, name: `Template ${id} v${rng.int(1, 100)}`, body: '{}' };
      }
      break;
    }
    case 'portfolio_created': {
      const id = `portfolio_${state.portfolioSeq++}`;
      state.portfolios.add(id);
      payload = { id, name: `Portfolio ${id}` };
      break;
    }
    case 'portfolio_updated': {
      const ids = [...state.portfolios];
      if (ids.length === 0) {
        const id = `portfolio_${state.portfolioSeq++}`;
        state.portfolios.add(id);
        payload = { id, name: `Portfolio ${id}` };
      } else {
        const id = rng.pick(ids);
        payload = { id, name: `Portfolio ${id} v${rng.int(1, 100)}` };
      }
      break;
    }
    case 'admin_added': {
      const id = `admin_${state.adminSeq++}`;
      state.admins.add(id);
      payload = { id };
      break;
    }
    case 'admin_removed': {
      const ids = [...state.admins];
      if (ids.length === 0) {
        const id = `admin_${state.adminSeq++}`;
        state.admins.add(id);
        payload = { id };
      } else {
        const id = rng.pick(ids);
        state.admins.delete(id);
        payload = { id };
      }
      break;
    }
  }

  return { ledger, txHash, kind, payload };
}

interface SimState {
  folderSeq: number;
  templateSeq: number;
  portfolioSeq: number;
  adminSeq: number;
  folders: Set<string>;
  templates: Set<string>;
  portfolios: Set<string>;
  admins: Set<string>;
}

function newSimState(): SimState {
  return {
    folderSeq: 0,
    templateSeq: 0,
    portfolioSeq: 0,
    adminSeq: 0,
    folders: new Set(),
    templates: new Set(),
    portfolios: new Set(),
    admins: new Set(),
  };
}

function generateChain(rng: Rng, startLedger: number, endLedger: number): ChainEvent[] {
  const state = newSimState();
  const events: ChainEvent[] = [];
  for (let ledger = startLedger; ledger < endLedger; ledger++) {
    const n = rng.int(0, 4);
    for (let i = 0; i < n; i++) {
      events.push(makeEvent(rng, ledger, state));
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Fake EventSource: moving retention window + injected faults.
// ---------------------------------------------------------------------------
type FaultKind = 'timeout' | 'http_500' | 'http_429' | 'malformed' | 'range_error';

class FakeEventSource {
  private events: ChainEvent[];
  private retentionStart: number;
  private retentionEnd: number;
  private rng: Rng;
  private faultRate: number;
  public readonly gaps: Array<{ from: number; to: number }> = [];

  constructor(events: ChainEvent[], rng: Rng, faultRate: number) {
    this.events = events;
    this.rng = rng;
    this.faultRate = faultRate;
    const minLedger = events.length ? events[0].ledger : 0;
    const maxLedger = events.length ? events[events.length - 1].ledger : 0;
    this.retentionStart = minLedger;
    this.retentionEnd = maxLedger + 1;
  }

  // Advance the retention window forward, dropping old ledgers.
  advanceRetention(by: number): void {
    this.retentionStart += by;
  }

  private maybeFault(): FaultKind | null {
    if (this.rng.float() >= this.faultRate) return null;
    return this.rng.pick<FaultKind>([
      'timeout',
      'http_500',
      'http_429',
      'malformed',
      'range_error',
    ]);
  }

  async getHealth(): Promise<{ ok: boolean; latestLedger: number }> {
    return { ok: true, latestLedger: this.retentionEnd };
  }

  async getEvents(fromLedger: number, limit: number): Promise<EventPage> {
    const fault = this.maybeFault();
    if (fault === 'timeout') {
      throw new Error('ETIMEDOUT: rpc timeout');
    }
    if (fault === 'http_500') {
      throw new Error('HTTP 500: internal server error');
    }
    if (fault === 'http_429') {
      throw new Error('HTTP 429: rate limited');
    }
    if (fault === 'malformed') {
      throw new Error('MALFORMED_BODY: unexpected token in JSON');
    }
    if (fault === 'range_error') {
      throw new LedgerRangeError(fromLedger, fromLedger + limit);
    }

    if (fromLedger < this.retentionStart) {
      // Documented gap: ledgers before retention start are unavailable.
      const gapTo = Math.min(this.retentionStart, fromLedger + limit);
      this.gaps.push({ from: fromLedger, to: gapTo });
      throw new LedgerRangeError(fromLedger, gapTo);
    }

    const page = this.events
      .filter((e) => e.ledger >= fromLedger && e.ledger < fromLedger + limit)
      .slice(0, limit);

    const nextCursor =
      page.length > 0
        ? String(page[page.length - 1].ledger + 1)
        : String(fromLedger + limit);

    return { events: page, cursor: nextCursor };
  }
}

// ---------------------------------------------------------------------------
// Postgres proxy: injects transient SQLSTATEs / connection kills.
// ---------------------------------------------------------------------------
const TRANSIENT_SQLSTATES = ['40001', '40P01', '08006'] as const;

class PgProxyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PgProxyError';
  }
}

class FaultyPool {
  private rng: Rng;
  private faultRate: number;
  private killRate: number;
  public readonly injected: Array<{ code: string; sql: string }> = [];

  constructor(public readonly pool: Pool, rng: Rng, faultRate: number, killRate: number) {
    this.rng = rng;
    this.faultRate = faultRate;
    this.killRate = killRate;
  }

  private maybeThrow(sql: string): void {
    if (this.rng.float() < this.faultRate) {
      const code = this.rng.pick(TRANSIENT_SQLSTATES);
      this.injected.push({ code, sql });
      throw new PgProxyError(code, `injected transient ${code}`);
    }
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    this.maybeThrow(sql);
    if (this.rng.float() < this.killRate) {
      // Simulate a killed connection: close the underlying client.
      const client = await this.pool.connect();
      try {
        // Force a broken connection by issuing a cancel-like error.
        throw new PgProxyError('08006', 'connection terminated unexpectedly');
      } finally {
        client.release(true);
      }
    }
    return this.pool.query<T>(sql, params as never);
  }

  async connect(): Promise<PoolClient> {
    return this.pool.connect();
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Read-model snapshot for comparison.
// ---------------------------------------------------------------------------
interface ReadModel {
  folders: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; name: string; body: string }>;
  portfolios: Array<{ id: string; name: string }>;
  admins: Array<{ id: string }>;
  contractEvents: Array<{ ledger: number; tx_hash: string; kind: string }>;
  cursor: number | null;
}

async function snapshotReadModel(pool: Pool, schema: string): Promise<ReadModel> {
  const q = async <T extends Record<string, unknown>>(sql: string) => {
    const res = await pool.query<T>(sql);
    return res.rows;
  };
  const folders = await q<{ id: string; name: string }>(
    `SELECT id, name FROM ${schema}.folders ORDER BY id`,
  );
  const templates = await q<{ id: string; name: string; body: string }>(
    `SELECT id, name, body FROM ${schema}.templates ORDER BY id`,
  );
  const portfolios = await q<{ id: string; name: string }>(
    `SELECT id, name FROM ${schema}.portfolios ORDER BY id`,
  );
  const admins = await q<{ id: string }>(`SELECT id FROM ${schema}.admins ORDER BY id`);
  const contractEvents = await q<{ ledger: number; tx_hash: string; kind: string }>(
    `SELECT ledger, tx_hash, kind FROM ${schema}.contract_events ORDER BY ledger, tx_hash`,
  );
  const stateRows = await q<{ cursor: number | null }>(
    `SELECT cursor FROM ${schema}.indexer_state WHERE id = 1`,
  );
  return {
    folders,
    templates,
    portfolios,
    admins,
    contractEvents,
    cursor: stateRows.length ? stateRows[0].cursor : null,
  };
}

// ---------------------------------------------------------------------------
// Schema setup / teardown.
// ---------------------------------------------------------------------------
async function createSchema(pool: Pool, schema: string): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${schema}.templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${schema}.portfolios (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${schema}.admins (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS ${schema}.contract_events (
      ledger INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (ledger, tx_hash)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.indexer_state (
      id INTEGER PRIMARY KEY,
      cursor INTEGER
    );
    INSERT INTO ${schema}.indexer_state (id, cursor) VALUES (1, NULL)
      ON CONFLICT (id) DO NOTHING;
  `);
}

async function dropSchema(pool: Pool, schema: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

// ---------------------------------------------------------------------------
// Indexer core: applies events idempotently, advances cursor atomically.
// ---------------------------------------------------------------------------
interface IndexerOptions {
  source: FakeEventSource;
  db: FaultyPool;
  schema: string;
  pageSize: number;
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
}

class Indexer {
  private stopped = false;
  constructor(private opts: IndexerOptions) {}

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    const { source, db, schema, pageSize, maxRetries, sleep } = this.opts;
    let cursor = await this.loadCursor();
    const health = await source.getHealth();
    const target = health.latestLedger;

    while (!this.stopped && cursor < target) {
      let page: EventPage | null = null;
      let attempts = 0;
      while (page === null) {
        try {
          page = await source.getEvents(cursor, pageSize);
        } catch (err) {
          if (err instanceof LedgerRangeError) {
            // Documented gap: skip ahead to retention start.
            cursor = err.to;
            await this.persistCursor(cursor);
            break;
          }
          attempts++;
          if (attempts > maxRetries) throw err;
          await sleep(Math.min(2 ** attempts, 50));
        }
      }
      if (page === null) continue;
      if (page.events.length === 0) {
        cursor = Number(page.cursor ?? cursor + pageSize);
        await this.persistCursor(cursor);
        continue;
      }

      // Apply events + advance cursor atomically, with retry on transient faults.
      let applied = false;
      let dbAttempts = 0;
      while (!applied) {
        try {
          await this.applyPage(page.events, Number(page.cursor ?? cursor));
          applied = true;
        } catch (err) {
          if (err instanceof PgProxyError && isTransient(err.code)) {
            dbAttempts++;
            if (dbAttempts > maxRetries) throw err;
            await sleep(Math.min(2 ** dbAttempts, 50));
            continue;
          }
          throw err;
        }
      }
      cursor = Number(page.cursor ?? cursor + pageSize);
    }
  }

  private async loadCursor(): Promise<number> {
    const { db, schema } = this.opts;
    const res = await db.query<{ cursor: number | null }>(
      `SELECT cursor FROM ${schema}.indexer_state WHERE id = 1`,
    );
    const c = res.rows[0]?.cursor;
    return c === null || c === undefined ? 0 : Number(c);
  }

  private async persistCursor(cursor: number): Promise<void> {
    const { db, schema } = this.opts;
    await db.query(`UPDATE ${schema}.indexer_state SET cursor = $1 WHERE id = 1`, [cursor]);
  }

  private async applyPage(events: ChainEvent[], nextCursor: number): Promise<void> {
    const { db, schema } = this.opts;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const ev of events) {
        await client.query(
          `INSERT INTO ${schema}.contract_events (ledger, tx_hash, kind)
           VALUES ($1, $2, $3) ON CONFLICT (ledger, tx_hash) DO NOTHING`,
          [ev.ledger, ev.txHash, ev.kind],
        );
        switch (ev.kind) {
          case 'folder_created':
          case 'folder_renamed':
            await client.query(
              `INSERT INTO ${schema}.folders (id, name) VALUES ($1, $2)
               ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
              [ev.payload.id, ev.payload.name],
            );
            break;
          case 'template_created':
          case 'template_updated':
            await client.query(
              `INSERT INTO ${schema}.templates (id, name, body) VALUES ($1, $2, $3)
               ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, body = EXCLUDED.body`,
              [ev.payload.id, ev.payload.name, ev.payload.body],
            );
            break;
          case 'portfolio_created':
          case 'portfolio_updated':
            await client.query(
              `INSERT INTO ${schema}.portfolios (id, name) VALUES ($1, $2)
               ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
              [ev.payload.id, ev.payload.name],
            );
            break;
          case 'admin_added':
            await client.query(
              `INSERT INTO ${schema}.admins (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
              [ev.payload.id],
            );
            break;
          case 'admin_removed':
            await client.query(`DELETE FROM ${schema}.admins WHERE id = $1`, [ev.payload.id]);
            break;
        }
      }
      await client.query(
        `UPDATE ${schema}.indexer_state SET cursor = $1 WHERE id = 1`,
        [nextCursor],
      );
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors on dead connections
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

function isTransient(code: string): boolean {
  return (TRANSIENT_SQLSTATES as readonly string[]).includes(code);
}

// ---------------------------------------------------------------------------
// Simulation orchestration.
// ---------------------------------------------------------------------------
interface SimConfig {
  seed: number;
  startLedger: number;
  endLedger: number;
  pageSize: number;
  faultRate: number;
  dbFaultRate: number;
  dbKillRate: number;
  retentionAdvance: number;
  restartProbability: number;
  maxRetries: number;
}

function configForSeed(seed: number): SimConfig {
  const rng = new Rng(seed);
  const startLedger = 1000;
  const endLedger = startLedger + rng.int(40, 120);
  return {
    seed,
    startLedger,
    endLedger,
    pageSize: rng.int(3, 12),
    faultRate: 0.15,
    dbFaultRate: 0.1,
    dbKillRate: 0.02,
    retentionAdvance: rng.int(0, 3),
    restartProbability: 0.15,
    maxRetries: 8,
  };
}

const noSleep = async (_ms: number): Promise<void> => {
  // Deterministic: no real waiting.
};

async function runClean(pool: Pool, schema: string, cfg: SimConfig): Promise<ReadModel> {
  await createSchema(pool, schema);
  const rng = new Rng(cfg.seed);
  const events = generateChain(rng, cfg.startLedger, cfg.endLedger);
  const source = new FakeEventSource(events, new Rng(cfg.seed + 1), 0);
  const db = new FaultyPool(pool, new Rng(cfg.seed + 2), 0, 0);
  const indexer = new Indexer({
    source,
    db,
    schema,
    pageSize: cfg.pageSize,
    maxRetries: cfg.maxRetries,
    sleep: noSleep,
  });
  await indexer.run();
  return snapshotReadModel(pool, schema);
}

async function runFaulty(pool: Pool, schema: string, cfg: SimConfig): Promise<ReadModel> {
  await createSchema(pool, schema);
  const rng = new Rng(cfg.seed);
  const events = generateChain(rng, cfg.startLedger, cfg.endLedger);
  const source = new FakeEventSource(events, new Rng(cfg.seed + 1), cfg.faultRate);
  const db = new FaultyPool(pool, new Rng(cfg.seed + 2), cfg.dbFaultRate, cfg.dbKillRate);

  let indexer = new Indexer({
    source,
    db,
    schema,
    pageSize: cfg.pageSize,
    maxRetries: cfg.maxRetries,
    sleep: noSleep,
  });

  // Restart orchestration: periodically stop and recreate the indexer mid-run.
  const restartRng = new Rng(cfg.seed + 3);
  let running = true;
  const runPromise = (async () => {
    while (running) {
      await indexer.run();
      if (!running) break;
      if (restartRng.float() < cfg.restartProbability) {
        indexer.stop();
        // Advance retention window between restarts.
        source.advanceRetention(cfg.retentionAdvance);
        indexer = new Indexer({
          source,
          db,
          schema,
          pageSize: cfg.pageSize,
          maxRetries: cfg.maxRetries,
          sleep: noSleep,
        });
      } else {
        break;
      }
    }
  })();

  await runPromise;
  running = false;
  return snapshotReadModel(pool, schema);
}

function normalizeForComparison(model: ReadModel, gaps: Array<{ from: number; to: number }>): ReadModel {
  // Remove contract_events that fall inside documented retention gaps.
  const filtered = model.contractEvents.filter(
    (e) => !gaps.some((g) => e.ledger >= g.from && e.ledger < g.to),
  );
  return { ...model, contractEvents: filtered };
}

// ---------------------------------------------------------------------------
// Test suite.
// ---------------------------------------------------------------------------
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SEEDS = Number(process.env.SIMULATION_SEEDS ?? '50');

describe.skipIf(!TEST_DATABASE_URL)('indexer fault-injection simulation (#250)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it(`runs ${SEEDS} seeds deterministically`, async () => {
    const failures: Array<{ seed: number; message: string }> = [];
    for (let i = 0; i < SEEDS; i++) {
      const seed = 1000 + i;
      const cfg = configForSeed(seed);
      const cleanSchema = `sim_clean_${seed}`;
      const faultySchema = `sim_faulty_${seed}`;
      try {
        const clean = await runClean(pool, cleanSchema, cfg);
        const faulty = await runFaulty(pool, faultySchema, cfg);

        // Determinism: re-run faulty with same seed, expect identical result.
        const faultyAgain = await runFaulty(pool, `sim_faulty2_${seed}`, cfg);

        const gaps: Array<{ from: number; to: number }> = [];
        const cleanNorm = normalizeForComparison(clean, gaps);
        const faultyNorm = normalizeForComparison(faulty, gaps);

        expect(faultyAgain, `seed ${seed}: non-deterministic run`).toEqual(faulty);
        expect(faultyNorm, `seed ${seed}: read model mismatch`).toEqual(cleanNorm);
      } catch (err) {
        failures.push({ seed, message: (err as Error).message });
      } finally {
        await dropSchema(pool, cleanSchema).catch(() => undefined);
        await dropSchema(pool, faultySchema).catch(() => undefined);
        await dropSchema(pool, `sim_faulty2_${seed}`).catch(() => undefined);
      }
    }
    if (failures.length > 0) {
      const summary = failures
        .map((f) => `seed=${f.seed}: ${f.message}`)
        .join('\n');
      throw new Error(`Simulation failures (reproduce with SIMULATION_SEEDS=1):\n${summary}`);
    }
  }, 180_000);

  // Pinned-seed regression tests for bugs discovered during simulation.
  // Each entry pins a seed that previously failed; keep these forever.
  const pinnedSeeds: number[] = [];

  for (const seed of pinnedSeeds) {
    it(`pinned seed ${seed} regression`, async () => {
      const cfg = configForSeed(seed);
      const cleanSchema = `sim_pin_clean_${seed}`;
      const faultySchema = `sim_pin_faulty_${seed}`;
      try {
        const clean = await runClean(pool, cleanSchema, cfg);
        const faulty = await runFaulty(pool, faultySchema, cfg);
        expect(normalizeForComparison(faulty, [])).toEqual(normalizeForComparison(clean, []));
      } finally {
        await dropSchema(pool, cleanSchema).catch(() => undefined);
        await dropSchema(pool, faultySchema).catch(() => undefined);
      }
    });
  }
});

// Exported for reuse / debugging.
export {
  Rng,
  mulberry32,
  generateChain,
  FakeEventSource,
  FaultyPool,
  Indexer,
  configForSeed,
  runClean,
  runFaulty,
  LedgerRangeError,
  PgProxyError,
};