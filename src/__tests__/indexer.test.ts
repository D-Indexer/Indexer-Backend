import { xdr } from '@stellar/stellar-sdk';
import { getCursor, handleEvent, saveCursor, scValToString } from '../indexer/stellar';

function topic(value: string): string {
  return xdr.ScVal.scvString(value).toXDR('base64');
}

function event(eventType: string, args: string[] = [], contractId = 'CCONTRACT') {
  return {
    contractId,
    ledger: 123,
    topic: [topic(eventType), ...args.map(topic)],
  } as any;
}

describe('stellar indexer', () => {
  it('decodes string ScVals', () => {
    expect(scValToString(topic('folder_claimed'))).toBe('folder_claimed');
  });

  it('loads cursor from indexer state', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ value: '456' }] });

    await expect(getCursor(query as any)).resolves.toBe('456');

    expect(query).toHaveBeenCalledWith('SELECT value FROM indexer_state WHERE key = $1', [
      'indexer_cursor',
    ]);
  });

  it('defaults cursor to zero when state is empty', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });

    await expect(getCursor(query as any)).resolves.toBe('0');
  });

  it('saves cursor with an upsert', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });

    await saveCursor('789', query as any);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO indexer_state'), [
      'indexer_cursor',
      '789',
    ]);
  });

  it('upserts folder on folder_claimed events', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });

    await handleEvent(event('folder_claimed', ['GABC', 'alice', 'QmCid', '7']), {
      query: query as any,
      contractId: 'CCONTRACT',
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO folders'), [
      'GABC',
      'alice',
      'QmCid',
      7,
    ]);
  });

  it('ignores events from other contracts', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });

    await handleEvent(event('folder_claimed', ['GABC', 'alice', 'QmCid', '7'], 'COTHER'), {
      query: query as any,
      contractId: 'CCONTRACT',
    });

    expect(query).not.toHaveBeenCalled();
  });

  it('updates credentials on credential_linked events', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });

    await handleEvent(event('credential_linked', ['GABC', 'github', 'proof']), {
      query: query as any,
      contractId: 'CCONTRACT',
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO credentials'), [
      'GABC',
      'github',
      'proof',
    ]);
  });

  it('rejects malformed events', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });

    await expect(
      handleEvent(event('folder_claimed', ['GABC']), {
        query: query as any,
        contractId: 'CCONTRACT',
      })
    ).rejects.toThrow(/Malformed folder_claimed/);
  });
});
