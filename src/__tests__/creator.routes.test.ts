import { createCreatorRoutes } from '../routes/creator.routes';
import * as templateService from '../services/template';
import { encodeCursor } from '../http/pagination';
import { serve, type TestServer } from './httpHarness';

const CREATOR = 'GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ';

function fakeDb(rows: unknown[] = []) {
  return { query: jest.fn().mockResolvedValue({ rows }) } as any;
}

describe('creator service', () => {
  it('lists a creator templates oldest first from the first page', async () => {
    const db = fakeDb([]);
    await templateService.listTemplatesByCreator(db, CREATOR, { limit: 20, after: null });
    expect(db.query).toHaveBeenCalledWith(templateService.LIST_CREATOR_TEMPLATES_SQL, [CREATOR, 21]);
    expect(templateService.LIST_CREATOR_TEMPLATES_SQL).toContain('ORDER BY t.registered_at, t.id');
  });

  it('continues after the (registered_at, id) cursor', async () => {
    const db = fakeDb([]);
    await templateService.listTemplatesByCreator(db, CREATOR, {
      limit: 5,
      after: ['2026-11-09T22:14:42.000000Z', '3'],
    });
    expect(db.query).toHaveBeenCalledWith(templateService.LIST_CREATOR_TEMPLATES_AFTER_SQL, [
      CREATOR,
      6,
      '2026-11-09T22:14:42.000000Z',
      '3',
    ]);
  });

  it('maps creator stats and echoes the address', async () => {
    const db = fakeDb([{ template_count: '3', total_usage: '17' }]);
    await expect(templateService.getCreatorStats(db, CREATOR)).resolves.toEqual({
      address: CREATOR,
      templateCount: 3,
      totalUsage: 17,
    });
  });
});

describe('creator routes', () => {
  let server: TestServer;
  const db = { query: jest.fn() };

  beforeAll(async () => {
    server = await serve({ '/creators': createCreatorRoutes({ db: db as any }) });
  });
  afterAll(() => server.close());
  afterEach(() => db.query.mockReset());

  it('returns zero stats for an unknown creator instead of 404', async () => {
    db.query.mockResolvedValue({ rows: [{ template_count: '0', total_usage: '0' }] });

    const res = await server.get(`/creators/${CREATOR}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ address: CREATOR, templateCount: 0, totalUsage: 0 });
  });

  it('returns an empty list for an unknown creator instead of 404', async () => {
    db.query.mockResolvedValue({ rows: [] });

    const res = await server.get(`/creators/${CREATOR}/templates`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ templates: [], nextCursor: null });
  });

  it('returns templates with usageCount and a cursor when more exist', async () => {
    const row = (id: string) => ({
      id,
      metadata_uri: `ipfs://t${id}`,
      creator: CREATOR,
      registered_at: new Date('2026-11-09T22:14:42.000Z'),
      usage_count: '2',
      cursor_ts: '2026-11-09T22:14:42.000000Z',
    });
    db.query.mockResolvedValue({ rows: [row('1'), row('2')] });

    const res = await server.get(`/creators/${CREATOR}/templates?limit=1`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      templates: [
        {
          id: 1,
          metadataUri: 'ipfs://t1',
          creator: CREATOR,
          registeredAt: '2026-11-09T22:14:42.000Z',
          usageCount: 2,
        },
      ],
      nextCursor: encodeCursor(['2026-11-09T22:14:42.000000Z', '1']),
    });
  });

  it.each([`/creators/not-an-address`, `/creators/not-an-address/templates`])(
    'rejects an invalid address on %s with 400',
    async (path) => {
      const res = await server.get(path);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid Stellar address' });
      expect(db.query).not.toHaveBeenCalled();
    }
  );

  it('rejects a bad cursor with 400', async () => {
    const res = await server.get(`/creators/${CREATOR}/templates?cursor=%%%`);
    expect(res.status).toBe(400);
  });
});
