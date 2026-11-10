import { LedgerRangeError, EventSource, GetEventsResult } from '../indexer/rpc';
import {
  backoffDelay,
  createIndexer,
  IndexerConfig,
  ledgerFromCursor,
  pollOnce,
  processPage,
  RetentionGapError,
} from '../indexer/stellar';
import { addr, makeEvent, OWNER, str, TESTNET_CONTRACT, testnetEvents, u32 } from './eventFixtures';

type Call = { sql: string; params?: unknown[] };

/** Records every query; behaviour can be overridden per test. */
function fakeDb(options: { state?: Record<string, string>; existingIds?: string[]; failOn?: RegExp } = {}) {
  const calls: Call[] = [];
  const existing = new Set(options.existingIds ?? []);
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (options.failOn?.test(sql)) throw new Error('connection terminated');
    if (sql.startsWith('SELECT key, value FROM indexer_state')) {
      return {
        rows: Object.entries(options.state ?? {}).map(([key, value]) => ({ key, value })),
        rowCount: 0,
      };
    }
    if (sql.includes('INSERT INTO contract_events')) {
      const id = (params as string[])[0];
      if (existing.has(id)) return { rows: [], rowCount: 0 };
      existing.add(id);
      return { rows: [{ id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: jest.fn() };
  return { db: { connect: jest.fn(async () => client), query } as any, calls, client };
}

const sqls = (calls: Call[]) => calls.map((c) => c.sql.trim().split(/\s+/).slice(0, 3).join(' '));

function page(events = testnetEvents, extra: Partial<GetEventsResult> = {}): GetEventsResult {
  return { events, cursor: 'next-cursor', latestLedger: 5654239, oldestLedger: 5533280, ...extra };
}

const config: IndexerConfig = {
  contractId: TESTNET_CONTRACT,
  pollIntervalMs: 1000,
  pageLimit: 100,
  onRetentionGap: 'halt',
  maxBackoffMs: 60000,
};

function fakeRpc(overrides: Partial<EventSource> = {}): jest.Mocked<EventSource> {
  return {
    getEvents: jest.fn().mockResolvedValue(page([])),
    getHealth: jest.fn().mockResolvedValue({ status: 'healthy', latestLedger: 200, oldestLedger: 100 }),
    ...overrides,
  } as jest.Mocked<EventSource>;
}

describe('processPage', () => {
  it('writes events and the cursor in one transaction', async () => {
    const { db, calls, client } = fakeDb();

    const result = await processPage(db, TESTNET_CONTRACT, page());

    expect(result).toEqual({ applied: 10, ignored: 0, rejected: 0, duplicates: 0 });
    const order = sqls(calls);
    expect(order[0]).toBe('BEGIN');
    expect(order[order.length - 1]).toBe('COMMIT');
    const cursorWrite = calls.findIndex((c) => c.params?.[0] === 'cursor');
    expect(calls[cursorWrite].params).toEqual(['cursor', 'next-cursor']);
    expect(cursorWrite).toBeLessThan(order.length - 1);
    expect(client.release).toHaveBeenCalled();
  });

  it('skips events it has already stored', async () => {
    const { db, calls } = fakeDb({ existingIds: testnetEvents.map((e) => e.id) });

    const result = await processPage(db, TESTNET_CONTRACT, page());

    expect(result.duplicates).toBe(10);
    expect(calls.some((c) => /INSERT INTO (folders|portfolios|templates)/.test(c.sql))).toBe(false);
  });

  it('rolls back everything, including the cursor, when a write fails', async () => {
    const { db, calls, client } = fakeDb({ failOn: /INSERT INTO portfolios/ });

    await expect(processPage(db, TESTNET_CONTRACT, page())).rejects.toThrow('connection terminated');

    expect(sqls(calls)).toContain('ROLLBACK');
    expect(sqls(calls)).not.toContain('COMMIT');
    expect(calls.some((c) => c.params?.[0] === 'cursor')).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  it('stores malformed events as rejected and keeps going', async () => {
    const { db, calls } = fakeDb();
    const bad = makeEvent('folder_cl', [addr(OWNER)]);
    const good = makeEvent('port_upd', [addr(OWNER), str('bafy')]);

    const result = await processPage(db, TESTNET_CONTRACT, page([bad, good]));

    expect(result).toMatchObject({ applied: 1, rejected: 1 });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO contract_events'))!;
    expect(insert.params?.[9]).toBe('rejected');
    expect(insert.params?.[10]).toMatch(/missing field 1/);
    expect(sqls(calls)).toContain('COMMIT');
  });

  it('marks unknown topics as ignored', async () => {
    const { db } = fakeDb();
    const result = await processPage(db, TESTNET_CONTRACT, page([makeEvent('future_evt', [u32(1)])]));
    expect(result).toMatchObject({ ignored: 1, applied: 0 });
  });

  it('drops events from other contracts', async () => {
    const { db, calls } = fakeDb();
    const other = makeEvent('init', [addr(OWNER)], {
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    await processPage(db, TESTNET_CONTRACT, page([other]));
    expect(calls.some((c) => c.sql.includes('INSERT INTO contract_events'))).toBe(false);
  });
});

describe('pollOnce', () => {
  it('starts at the oldest retained ledger when there is no cursor or start ledger', async () => {
    const { db } = fakeDb();
    const rpc = fakeRpc();

    await pollOnce({ db, rpc, config });

    expect(rpc.getEvents).toHaveBeenCalledWith({
      contractId: TESTNET_CONTRACT,
      limit: 100,
      startLedger: 100,
    });
  });

  it('prefers the saved cursor, then a reset start ledger, then INDEXER_START_LEDGER', async () => {
    const rpc = fakeRpc();
    await pollOnce({ db: fakeDb({ state: { cursor: 'abc', start_ledger: '7' } }).db, rpc, config });
    await pollOnce({
      db: fakeDb({ state: { start_ledger: '7' } }).db,
      rpc,
      config: { ...config, startLedger: 9 },
    });
    await pollOnce({ db: fakeDb().db, rpc, config: { ...config, startLedger: 9 } });

    expect(rpc.getEvents.mock.calls.map(([p]) => p.cursor ?? p.startLedger)).toEqual(['abc', 7, 9]);
    expect(rpc.getHealth).not.toHaveBeenCalled();
  });

  it('halts with a clear error when the cursor is older than the retention window', async () => {
    const { db, calls } = fakeDb({ state: { cursor: '0021474836480000000-0000000000' } });
    const rpc = fakeRpc({
      getEvents: jest.fn().mockRejectedValue(new LedgerRangeError('range', 5533280, 5654239)),
    });

    const err = await pollOnce({ db, rpc, config }).catch((e) => e);

    expect(err).toBeInstanceOf(RetentionGapError);
    expect(err.message).toMatch(/ledger 5000000.*from 5533280.*docs\/operations.md/);
    expect(calls.find((c) => c.params?.[0] === 'status')?.params).toEqual(['status', 'retention_gap']);
  });

  it('skips to the oldest retained ledger when configured to', async () => {
    const { db, calls } = fakeDb({ state: { start_ledger: '50' } });
    const rpc = fakeRpc({
      getEvents: jest
        .fn()
        .mockRejectedValueOnce(new LedgerRangeError('range', 100, 200))
        .mockResolvedValueOnce(page([])),
    });

    await pollOnce({ db, rpc, config: { ...config, onRetentionGap: 'skip' } });

    expect(rpc.getEvents).toHaveBeenLastCalledWith({
      contractId: TESTNET_CONTRACT,
      limit: 100,
      startLedger: 101,
    });
    const gap = calls.find((c) => c.params?.[0] === 'last_gap');
    expect(JSON.parse(gap!.params![1] as string)).toMatchObject({ missedFrom: 50, resumedAt: 101 });
  });

  it('clamps an old INDEXER_START_LEDGER on an empty database instead of halting', async () => {
    const { db, calls } = fakeDb();
    const rpc = fakeRpc({
      getEvents: jest
        .fn()
        .mockRejectedValueOnce(new LedgerRangeError('range', 100, 200))
        .mockResolvedValueOnce(page([])),
    });

    await pollOnce({ db, rpc, config: { ...config, startLedger: 5 } });

    expect(rpc.getEvents).toHaveBeenLastCalledWith({
      contractId: TESTNET_CONTRACT,
      limit: 100,
      startLedger: 101,
    });
    const gap = calls.find((c) => c.params?.[0] === 'last_gap');
    expect(JSON.parse(gap!.params![1] as string)).toMatchObject({ missedFrom: 5, resumedAt: 101 });
  });

  it('does not treat a start ledger ahead of the RPC as a retention gap', async () => {
    const { db } = fakeDb({ state: { start_ledger: '300' } });
    const rangeError = new LedgerRangeError('range', 100, 200);
    const rpc = fakeRpc({ getEvents: jest.fn().mockRejectedValue(rangeError) });

    await expect(pollOnce({ db, rpc, config })).rejects.toBe(rangeError);
  });
});

describe('indexer loop', () => {
  it('reads the ledger out of an RPC event id', () => {
    expect(ledgerFromCursor(testnetEvents[0].id)).toBe(testnetEvents[0].ledger);
  });

  it('backs off exponentially up to the cap', () => {
    const c = { pollIntervalMs: 1000, maxBackoffMs: 10000 };
    expect([0, 1, 2, 3, 4, 10].map((n) => backoffDelay(c, n))).toEqual([
      1000, 2000, 4000, 8000, 10000, 10000,
    ]);
  });

  it('pages until caught up and waits for the in-flight poll on stop', async () => {
    const { db } = fakeDb();
    const full = page(Array.from({ length: 2 }, () => makeEvent('port_upd', [addr(OWNER), str('b')])));
    const rpc = fakeRpc({
      getEvents: jest.fn().mockResolvedValueOnce(full).mockResolvedValueOnce(page([])),
    });

    const indexer = createIndexer({ db, rpc, config: { ...config, pageLimit: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await indexer.stop();

    expect(rpc.getEvents).toHaveBeenCalledTimes(2);
  });
});
