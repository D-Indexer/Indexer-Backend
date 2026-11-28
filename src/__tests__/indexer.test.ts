import { LedgerRangeError, EventSource, GetEventsResult } from '../indexer/rpc';
import {
  backoffDelay,
  createIndexer,
  CursorInvalidError,
  IndexerConfig,
  isValidCursor,
  ledgerFromCursor,
  pollOnce,
  processPage,
  RetentionGapError,
} from '../indexer/stellar';
import { addr, makeEvent, OWNER, str, TESTNET_CONTRACT, testnetEvents, u32 } from './eventFixtures';
import { cassetteSource, listCassettes } from './rpcCassette';

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

describe('portfolio ownership transfers', () => {
  const NEW_OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  it('moves ownership and records history without losing portfolio data', async () => {
    const { db, calls } = fakeDb();
    const mint = makeEvent('port_init', [addr(OWNER), str('bafyportfolio')]);
    const transfer = makeEvent('port_xfer', [addr(OWNER), addr(NEW_OWNER), u32(1)]);

    const result = await processPage(db, TESTNET_CONTRACT, page([mint, transfer]));

    expect(result).toMatchObject({ applied: 2, rejected: 0, ignored: 0 });

    // Ownership is updated in place on the stable portfolio id, not re-minted.
    const update = calls.find((c) => /UPDATE portfolios\s+SET owner/.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.params).toEqual(expect.arrayContaining([NEW_OWNER]));

    // History row is appended for the transfer.
    const history = calls.find((c) => c.sql.includes('INSERT INTO ownership_history'));
    expect(history).toBeDefined();
    expect(history!.params).toEqual(expect.arrayContaining([NEW_OWNER, OWNER]));

    // No portfolio data is deleted or re-created by the transfer.
    expect(calls.some((c) => /DELETE FROM portfolios/.test(c.sql))).toBe(false);
    expect(sqls(calls)).toContain('COMMIT');
  });

  it('keeps non-transferred events writing the same read-model rows', async () => {
    const { db, calls } = fakeDb();

    await processPage(db, TESTNET_CONTRACT, page());

    expect(calls.some((c) => c.sql.includes('INSERT INTO folders'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO portfolios'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO templates'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO ownership_history'))).toBe(false);
    expect(calls.some((c) => /UPDATE portfolios\s+SET owner/.test(c.sql))).toBe(false);
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
    await pollOnce({
      db: fakeDb({ state: { cursor: '0024284788768636927-4294967295', start_ledger: '7' } }).db,
      rpc,
      config,
    });
    await pollOnce({
      db: fakeDb({ state: { start_ledger: '7' } }).db,
      rpc,
      config: { ...config, startLedger: 9 },
    });
    await pollOnce({ db: fakeDb().db, rpc, config: { ...config, startLedger: 9 } });

    expect(rpc.getEvents.mock.calls.map(([p]) => p.cursor ?? p.startLedger)).toEqual([
      '0024284788768636927-4294967295',
      7,
      9,
    ]);
    expect(rpc.getHealth).not.toHaveBeenCalled();
  });

  it('recovers from a corrupt cursor by resuming at last_ledger', async () => {
    const { db, calls } = fakeDb({ state: { cursor: 'garbage', last_ledger: '5654242' } });
    const rpc = fakeRpc();

    await pollOnce({ db, rpc, config });

    expect(rpc.getEvents).toHaveBeenCalledWith({
      contractId: TESTNET_CONTRACT,
      limit: 100,
      startLedger: 5654242,
    });
    expect(calls.find((c) => c.params?.[0] === 'cursor')?.params).toEqual(['cursor', null]);
    const recovered = calls.find((c) => c.params?.[0] === 'cursor_recovered');
    expect(JSON.parse(recovered!.params![1] as string)).toMatchObject({
      invalidCursor: 'garbage',
      resumedAt: 5654242,
    });
  });

  it('halts with cursor_invalid when neither the cursor nor last_ledger is valid', async () => {
    const { db, calls } = fakeDb({ state: { cursor: 'garbage' } });
    const rpc = fakeRpc();

    const err = await pollOnce({ db, rpc, config }).catch((e) => e);

    expect(err).toBeInstanceOf(CursorInvalidError);
    expect(err.message).toMatch(/reset-cursor/);
    expect(rpc.getEvents).not.toHaveBeenCalled();
    expect(calls.find((c) => c.params?.[0] === 'status')?.params).toEqual(['status', 'cursor_invalid']);
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
      startLedger: 100,
    });
    const gap = calls.find((c) => c.params?.[0] === 'last_gap');
    expect(JSON.parse(gap!.params![1] as string)).toMatchObject({
      missedFrom: 50,
      missedTo: 99,
      resumedAt: 100,
    });
  });

  it('retries from the new oldest ledger when the window moves while resuming', async () => {
    const { db, calls } = fakeDb({ state: { start_ledger: '50' } });
    const rpc = fakeRpc({
      getEvents: jest
        .fn()
        .mockRejectedValueOnce(new LedgerRangeError('range', 100, 200))
        .mockRejectedValueOnce(new LedgerRangeError('range', 105, 210))
        .mockResolvedValueOnce(page([])),
    });

    await pollOnce({ db, rpc, config: { ...config, onRetentionGap: 'skip' } });

    expect(rpc.getEvents.mock.calls.map(([p]) => p.startLedger)).toEqual([50, 100, 105]);
    const gap = calls.find((c) => c.params?.[0] === 'last_gap');
    expect(JSON.parse(gap!.params![1] as string)).toMatchObject({
      missedFrom: 50,
      missedTo: 104,
      resumedAt: 105,
    });
  });

  it('gives up after a bounded number of resume attempts', async () => {
    const { db } = fakeDb({ state: { start_ledger: '50' } });
    const rpc = fakeRpc({
      getEvents: jest
        .fn()
        .mockRejectedValueOnce(new LedgerRangeError('range', 100, 200))
        .mockRejectedValueOnce(new LedgerRangeError('range', 101, 201))
        .mockRejectedValueOnce(new LedgerRangeError('range', 102, 202))
        .mockRejectedValueOnce(new LedgerRangeError('range', 103, 203)),
    });

    const err = await pollOnce({
      db,
      rpc,
      config: { ...config, onRetentionGap: 'skip', maxGapResumeAttempts: 2 },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RetentionGapError);
    expect(rpc.getEvents).toHaveBeenCalledTimes(3);
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
      startLedger: 100,
    });
    const gap = calls.find((c) => c.params?.[0] === 'last_gap');
    expect(JSON.parse(gap!.params![1] as string)).toMatchObject({
      missedFrom: 5,
      missedTo: 99,
      resumedAt: 100,
    });
  });

  it('does not treat a start ledger ahead of the RPC as a retention gap', async () => {
    const { db } = fakeDb({ state: { start_ledger: '300' } });
    const rangeError = new LedgerRangeError('range', 100, 200);
    const rpc = fakeRpc({ getEvents: jest.fn().mockRejectedValue(rangeError) });

    await expect(pollOnce({ db, rpc, config })).rejects.toBe(rangeError);
  });
});

describe('scanned ledger', () => {
  it('records the ledger the RPC scanned to, not just the last event', async () => {
    const { db, calls } = fakeDb();
    // End-of-range cursor as returned for a partial page (ledger 5654242).
    await processPage(
      db,
      TESTNET_CONTRACT,
      page(testnetEvents, { cursor: '0024284788768636927-4294967295' })
    );

    expect(calls.find((c) => c.params?.[0] === 'last_ledger')?.params).toEqual(['last_ledger', '5654242']);
  });
});

describe('recorded RPC cassettes', () => {
  it('ships the four required cassettes', () => {
    expect(listCassettes()).toEqual(
      expect.arrayContaining(['full-catch-up', 'empty-page', 'retention-gap', 'partial-page-tip'])
    );
  });

  it('replays a full catch-up from a start ledger', async () => {
    const { db, calls } = fakeDb();
    const rpc = cassetteSource('full-catch-up');

    await pollOnce({ db, rpc, config: { ...config, startLedger: 100 } });
    await pollOnce({ db, rpc, config: { ...config, startLedger: 100 } });

    expect(rpc.getEvents).toHaveBeenNthCalledWith(1, {
      contractId: TESTNET_CONTRACT,
      limit: 100,
      startLedger: 100,
    });
    expect(rpc.getEvents).toHaveBeenNthCalledWith(2, {
      contractId: TESTNET_CONTRACT,
      limit: 100,
      cursor: '0024284788768636927-0000000001',
    });
    expect(calls.filter((c) => c.params?.[0] === 'cursor').map((c) => c.params![1])).toEqual([
      '0024284788768636927-0000000001',
      '0024284788768636927-4294967295',
    ]);
  });

  it('treats an empty page as caught up and keeps the returned cursor', async () => {
    const { db, calls } = fakeDb({ state: { cursor: '0024284788768636927-4294967295' } });
    const rpc = cassetteSource('empty-page');

    await pollOnce({ db, rpc, config });

    expect(rpc.getEvents).toHaveBeenCalledWith({
      contractId: TESTNET_CONTRACT,
      limit: 100,
      cursor: '0024284788768636927-4294967295',
    });
    expect(calls.some((c) => c.sql.includes('INSERT INTO contract_events'))).toBe(false);
    expect(calls.find((c) => c.params?.[0] === 'cursor')?.params).toEqual([
      'cursor',
      '0024284788768636927-4294967295',
    ]);
  });

  it('halts on a recorded retention-gap error', async () => {
    const { db, calls } = fakeDb({ state: { cursor: '0021474836480000000-0000000000' } });
    const rpc = cassetteSource('retention-gap');

    const err = await pollOnce({ db, rpc, config }).catch((e) => e);

    expect(err).toBeInstanceOf(RetentionGapError);
    expect(err.message).toMatch(/ledger 5000000.*from 5533280.*docs\/operations.md/);
    expect(calls.find((c) => c.params?.[0] === 'status')?.params).toEqual(['status', 'retention_gap']);
  });

  it('records the scanned ledger from a partial page at the tip', async () => {
    const { db, calls } = fakeDb({ state: { cursor: '0024284788768636927-0000000001' } });
    const rpc = cassetteSource('partial-page-tip');

    await pollOnce({ db, rpc, config });

    expect(calls.find((c) => c.params?.[0] === 'last_ledger')?.params).toEqual(['last_ledger', '5654242']);
    expect(calls.find((c) => c.params?.[0] === 'cursor')?.params).toEqual([
      'cursor',
      '0024284788768636927-4294967295',
    ]);
  });

  it('fails the test on an unrecorded request', async () => {
    const rpc = cassetteSource('empty-page');
    await expect(
      rpc.getEvents({ contractId: TESTNET_CONTRACT, limit: 100, startLedger: 1 })
    ).rejects.toThrow(/no cassette entry/);
  });
});

describe('indexer loop', () => {
  it('reads the ledger out of an RPC event id', () => {
    expect(ledgerFromCursor(testnetEvents[0].id)).toBe(testnetEvents[0].ledger);
  });

  it('validates saved cursors', () => {
    expect(isValidCursor('0024284788768636927-4294967295')).toBe(true);
    expect(isValidCursor('garbage')).toBe(false);
    expect(isValidCursor('')).toBe(false);
    expect(isValidCursor('0-0')).toBe(false);
    expect(isValidCursor('12-')).toBe(false);
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
