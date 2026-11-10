import pool from '../db/client';
import router from '../routes/health.routes';
import { invokeHandler, mockResponse } from './testUtils';

jest.mock('../db/client', () => ({ query: jest.fn() }));
const mockQuery = pool.query as jest.Mock;

// The router's single GET handler.
const handler = (router as any).stack[0].route.stack[0].handle;

function state(rows: Record<string, string>) {
  return { rows: Object.entries(rows).map(([key, value]) => ({ key, value })) };
}

describe('GET /health', () => {
  afterEach(() => jest.clearAllMocks());

  it('reports a fresh indexer', async () => {
    mockQuery.mockResolvedValue(
      state({ status: 'ok', last_ledger: '5647878', last_success_at: new Date().toISOString() })
    );
    const res = mockResponse();

    await invokeHandler(handler, { id: 'r1' } as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        indexer: expect.objectContaining({ status: 'ok', stale: false, lastLedger: 5647878 }),
      })
    );
  });

  it('flags a stalled indexer and surfaces its last error', async () => {
    mockQuery.mockResolvedValue(
      state({ status: 'retention_gap', last_success_at: '2020-01-01T00:00:00Z', last_error: 'gap' })
    );
    const res = mockResponse();

    await invokeHandler(handler, { id: 'r1' } as any, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        indexer: expect.objectContaining({ status: 'retention_gap', stale: true, lastError: 'gap' }),
      })
    );
  });

  it('returns 503 when the database is unreachable', async () => {
    mockQuery.mockRejectedValue(new Error('down'));
    const res = mockResponse();

    await invokeHandler(handler, { id: 'r1' } as any, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'degraded', db: 'unreachable' }));
  });
});
