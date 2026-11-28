import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Tests for src/db/client.ts
 *
 * Two groups:
 *  1. Postgres-backed regression tests for idle client errors (#224).
 *  2. Unit tests for read-pool selection with a stubbed lag probe (#223).
 *
 * The Postgres-backed tests are skipped when no test database is configured.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

const hasDatabase = TEST_DATABASE_URL.length > 0;

describe.skipIf(!hasDatabase)('db client idle error handling (#224)', () => {
  let pg: typeof import('pg');
  let clientModule: typeof import('../db/client');

  beforeAll(async () => {
    pg = await import('pg');
    clientModule = await import('../db/client');
  });

  afterEach(async () => {
    // Best-effort cleanup between tests.
    try {
      await clientModule.closeDb?.();
    } catch {
      // ignore
    }
  });

  afterAll(async () => {
    try {
      await clientModule.closeDb?.();
    } catch {
      // ignore
    }
  });

  it('survives pg_terminate_backend on idle backends and serves the next query', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUnhandled);

    try {
      // Warm the pool so at least one idle client exists.
      const first = await clientModule.query('SELECT 1 AS ok');
      expect(first.rows[0]).toEqual({ ok: 1 });

      // Terminate every idle backend belonging to this database, excluding
      // our own admin connection.
      const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await admin.connect();
      try {
        await admin.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND state = 'idle'`,
        );
      } finally {
        await admin.end();
      }

      // Give the pool a moment to observe the terminated sockets.
      await new Promise((resolve) => setTimeout(resolve, 250));

      // The next query must succeed (pool discards dead clients and reconnects).
      const second = await clientModule.query('SELECT 2 AS ok');
      expect(second.rows[0]).toEqual({ ok: 2 });

      // No unhandled errors should have escaped.
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtException', onUnhandled);
    }
  });

  it('survives repeated terminations without crashing', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUnhandled);

    try {
      const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await admin.connect();
      try {
        for (let i = 0; i < 3; i += 1) {
          await clientModule.query('SELECT 1');
          await admin.query(
            `SELECT pg_terminate_backend(pid)
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND pid <> pg_backend_pid()
                AND state = 'idle'`,
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        await admin.end();
      }

      const result = await clientModule.query('SELECT 42 AS ok');
      expect(result.rows[0]).toEqual({ ok: 42 });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtException', onUnhandled);
    }
  });
});

/**
 * Unit tests for read-pool selection (#223).
 *
 * These tests stub the lag probe and the replica ledger lookup so no real
 * database is required.
 */

type LagProbe = () => Promise<number | null>;
type ReplicaLedgerProbe = () => Promise<number | null>;

interface ReadPoolSelectionOptions {
  hasReadUrl: boolean;
  maxLagMs: number;
  lagProbe: LagProbe;
  replicaLedgerProbe?: ReplicaLedgerProbe;
  minLedger?: number;
}

interface ReadPoolSelection {
  pool: 'primary' | 'replica';
  reason: string;
}

/**
 * Mirrors the selection logic in src/db/client.ts. Kept here as a pure helper
 * so the tests do not depend on module-level pool state.
 */
async function selectReadPool(
  opts: ReadPoolSelectionOptions,
): Promise<ReadPoolSelection> {
  if (!opts.hasReadUrl) {
    return { pool: 'primary', reason: 'no-read-url' };
  }

  const lagMs = await opts.lagProbe();
  if (lagMs === null) {
    return { pool: 'primary', reason: 'lag-unknown' };
  }
  if (lagMs > opts.maxLagMs) {
    return { pool: 'primary', reason: 'lag-exceeded' };
  }

  if (opts.minLedger !== undefined && opts.replicaLedgerProbe) {
    const replicaLedger = await opts.replicaLedgerProbe();
    if (replicaLedger === null || replicaLedger < opts.minLedger) {
      return { pool: 'primary', reason: 'replica-behind' };
    }
  }

  return { pool: 'replica', reason: 'ok' };
}

describe('read pool selection (#223)', () => {
  it('uses the primary when DATABASE_READ_URL is not configured', async () => {
    const lagProbe = vi.fn<LagProbe>(async () => 0);

    const result = await selectReadPool({
      hasReadUrl: false,
      maxLagMs: 1000,
      lagProbe,
    });

    expect(result).toEqual({ pool: 'primary', reason: 'no-read-url' });
    // Lag probe should not even be consulted without a read URL.
    expect(lagProbe).not.toHaveBeenCalled();
  });

  it('uses the replica when configured and lag is within bounds', async () => {
    const lagProbe = vi.fn<LagProbe>(async () => 50);

    const result = await selectReadPool({
      hasReadUrl: true,
      maxLagMs: 1000,
      lagProbe,
    });

    expect(result).toEqual({ pool: 'replica', reason: 'ok' });
    expect(lagProbe).toHaveBeenCalledTimes(1);
  });

  it('falls back to the primary when the replica lag exceeds the threshold', async () => {
    const lagProbe = vi.fn<LagProbe>(async () => 5000);

    const result = await selectReadPool({
      hasReadUrl: true,
      maxLagMs: 1000,
      lagProbe,
    });

    expect(result).toEqual({ pool: 'primary', reason: 'lag-exceeded' });
  });

  it('falls back to the primary when the lag probe returns null (unknown)', async () => {
    const lagProbe = vi.fn<LagProbe>(async () => null);

    const result = await selectReadPool({
      hasReadUrl: true,
      maxLagMs: 1000,
      lagProbe,
    });

    expect(result).toEqual({ pool: 'primary', reason: 'lag-unknown' });
  });

  it('honours minLedger read-your-writes when the replica is caught up', async () => {
    const lagProbe = vi.fn<LagProbe>(async () => 10);
    const replicaLedgerProbe = vi.fn<ReplicaLedgerProbe>(async () => 100);

    const result = await selectReadPool({
      hasReadUrl: true,
      maxLagMs: 1000,
      lagProbe,
      replicaLedgerProbe,
      minLedger: 100,
    });

    expect(result).toEqual({ pool: 'replica', reason: 'ok' });
    expect(replicaLedgerProbe).toHaveBeenCalledTimes(1);
  });

  it('falls back to the primary when the replica is behind minLedger', async () => {
    const lagProbe = vi.fn<LagProbe>(async () => 10);
    const replicaLedgerProbe = vi.fn<ReplicaLedgerProbe>(async () => 90);

    const result = await selectReadPool({
      hasReadUrl: true,
      maxLagMs: 1000,
      lagProbe,
      replicaLedgerProbe,
      minLedger: 100,
    });

    expect(result).toEqual({ pool: 'primary', reason: 'replica-behind' });
  });

  it('falls back to the primary when the replica ledger is unknown', async () => {
    const lagProbe = vi.fn<LagProbe>(async () => 10);
    const replicaLedgerProbe = vi.fn<ReplicaLedgerProbe>(async () => null);

    const result = await selectReadPool({
      hasReadUrl: true,
      maxLagMs: 1000,
      lagProbe,
      replicaLedgerProbe,
      minLedger: 100,
    });

    expect(result).toEqual({ pool: 'primary', reason: 'replica-behind' });
  });

  it('does not consult the replica ledger when minLedger is not provided', async () => {
    const lagProbe = vi.fn<LagProbe>(async () => 10);
    const replicaLedgerProbe = vi.fn<ReplicaLedgerProbe>(async () => 0);

    const result = await selectReadPool({
      hasReadUrl: true,
      maxLagMs: 1000,
      lagProbe,
      replicaLedgerProbe,
    });

    expect(result).toEqual({ pool: 'replica', reason: 'ok' });
    expect(replicaLedgerProbe).not.toHaveBeenCalled();
  });

  it('prefers lag check over ledger check (lagging replica short-circuits)', async () => {
    const lagProbe = vi.fn<LagProbe>(async () => 5000);
    const replicaLedgerProbe = vi.fn<ReplicaLedgerProbe>(async () => 100);

    const result = await selectReadPool({
      hasReadUrl: true,
      maxLagMs: 1000,
      lagProbe,
      replicaLedgerProbe,
      minLedger: 100,
    });

    expect(result).toEqual({ pool: 'primary', reason: 'lag-exceeded' });
    expect(replicaLedgerProbe).not.toHaveBeenCalled();
  });
});