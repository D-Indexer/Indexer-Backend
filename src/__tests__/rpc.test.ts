import { createRpcClient, LedgerRangeError, redactUrl, RpcError } from '../indexer/rpc';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ok = { jsonrpc: '2.0', id: 1, result: { events: [], cursor: 'c', latestLedger: 10, oldestLedger: 1 } };
const params = { contractId: 'C', limit: 10, startLedger: 5 };

function client(fetchImpl: jest.Mock) {
  return createRpcClient({
    url: 'https://rpc.example/v1?apikey=secret',
    timeoutMs: 1000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => undefined,
  });
}

describe('rpc client', () => {
  it('sends a contract-filtered getEvents request', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(ok));
    await client(fetchImpl).getEvents({ contractId: 'CABC', limit: 50, cursor: 'cur' });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.method).toBe('getEvents');
    expect(body.params).toEqual({
      filters: [{ type: 'contract', contractIds: ['CABC'] }],
      pagination: { cursor: 'cur', limit: 50 },
    });
  });

  it('retries transient HTTP failures with backoff', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(ok));

    await expect(client(fetchImpl).getEvents(params)).resolves.toMatchObject({ cursor: 'c' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries network errors and gives up after maxAttempts', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(client(fetchImpl).getEvents(params)).rejects.toBeInstanceOf(RpcError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry invalid-request errors', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: -32602, message: 'startLedger must be positive' } }));

    await expect(client(fetchImpl).getEvents(params)).rejects.toThrow('startLedger must be positive');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('parses the retained ledger range from out-of-range errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        error: { code: -32600, message: 'startLedger must be within the ledger range: 5533280 - 5654239' },
      })
    );

    const err = await client(fetchImpl).getEvents(params).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerRangeError);
    expect(err).toMatchObject({ oldestLedger: 5533280, latestLedger: 5654239 });
  });

  it('never puts credentials or query strings in error messages', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, 500));
    const err = await client(fetchImpl).getEvents(params).catch((e) => e);

    expect(err.message).toContain('https://rpc.example/v1');
    expect(err.message).not.toContain('secret');
    expect(redactUrl('https://user:pw@host/path?key=1')).toBe('https://host/path');
  });
});
