import { createTemplateRoutes } from '../routes/template.routes';
import * as templateService from '../services/template';
import { encodeCursor } from '../http/pagination';
import { serve, type TestServer } from './httpHarness';

jest.mock('../services/template', () => {
  const actual = jest.requireActual('../services/template');
  return {
    ...actual,
    listTemplates: jest.fn(),
    getTemplate: jest.fn(),
    listTemplatePortfolios: jest.fn(),
  };
});

const svc = templateService as jest.Mocked<typeof templateService>;
const db = { query: jest.fn() } as any;
const template = {
  id: 2,
  metadataUri: 'ipfs://bafy',
  creator: 'GADMIN',
  registeredAt: new Date('2026-11-09T22:14:42.000Z'),
  usageCount: 3,
};
const json = JSON.parse(JSON.stringify(template));

describe('template routes', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await serve({ '/templates': createTemplateRoutes({ db }) });
  });
  afterAll(() => server.close());
  afterEach(() => jest.clearAllMocks());

  it('lists templates in id order by default', async () => {
    svc.listTemplates.mockResolvedValue([template]);

    const res = await server.get('/templates');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([json]);
    expect(svc.listTemplates).toHaveBeenCalledWith(db, 'id');
  });

  it('lists templates by popularity with ?sort=popular', async () => {
    svc.listTemplates.mockResolvedValue([template]);

    const res = await server.get('/templates?sort=popular');

    expect(res.status).toBe(200);
    expect(svc.listTemplates).toHaveBeenCalledWith(db, 'popular');
  });

  it('rejects unknown sort values with 400', async () => {
    const res = await server.get('/templates?sort=newest');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "sort must be 'id' or 'popular'" });
    expect(svc.listTemplates).not.toHaveBeenCalled();
  });

  it('returns one template including usageCount', async () => {
    svc.getTemplate.mockResolvedValue(template);

    const res = await server.get('/templates/2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(json);
    expect(svc.getTemplate).toHaveBeenCalledWith(db, 2);
  });

  it('rejects non-numeric template ids', async () => {
    const res = await server.get('/templates/abc');
    expect(res.status).toBe(400);
  });

  it.each(['4294967296', '99999999999'])('rejects template id %s outside the u32 range', async (id) => {
    const res = await server.get(`/templates/${id}`);
    expect(res.status).toBe(400);
    expect(svc.getTemplate).not.toHaveBeenCalled();
  });

  it('returns not found for missing templates', async () => {
    svc.getTemplate.mockResolvedValue(null);
    const res = await server.get('/templates/99');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Template not found' });
  });

  describe('GET /templates/:id/portfolios', () => {
    const portfolio = {
      owner: 'GA',
      templateId: 2,
      ipfsCid: 'bafkcid',
      mintedAt: new Date('2026-11-09T22:00:00.000Z'),
      updatedAt: new Date('2026-11-09T22:00:00.000Z'),
    };

    it('returns a page of portfolios and the next cursor', async () => {
      svc.getTemplate.mockResolvedValue(template);
      svc.listTemplatePortfolios.mockResolvedValue({ items: [portfolio], nextCursor: 'abc' });

      const res = await server.get('/templates/2/portfolios?limit=1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ portfolios: [JSON.parse(JSON.stringify(portfolio))], nextCursor: 'abc' });
      expect(svc.listTemplatePortfolios).toHaveBeenCalledWith(db, 2, { limit: 1, after: null });
    });

    it('passes the decoded cursor through', async () => {
      svc.getTemplate.mockResolvedValue(template);
      svc.listTemplatePortfolios.mockResolvedValue({ items: [], nextCursor: null });
      const cursor = encodeCursor(['2026-11-09T22:00:00.000000Z', 'GA']);

      await server.get(`/templates/2/portfolios?cursor=${cursor}`);

      expect(svc.listTemplatePortfolios).toHaveBeenCalledWith(db, 2, {
        limit: 20,
        after: ['2026-11-09T22:00:00.000000Z', 'GA'],
      });
    });

    it('returns 404 for an unknown template', async () => {
      svc.getTemplate.mockResolvedValue(null);
      const res = await server.get('/templates/9/portfolios');
      expect(res.status).toBe(404);
      expect(svc.listTemplatePortfolios).not.toHaveBeenCalled();
    });

    it.each([
      ['limit=0', 'limit must be an integer between 1 and 100'],
      ['limit=101', 'limit must be an integer between 1 and 100'],
      ['limit=abc', 'limit must be an integer between 1 and 100'],
      ['cursor=not-a-cursor', 'Invalid cursor'],
      [`cursor=${encodeCursor(['only-one-part'])}`, 'Invalid cursor'],
    ])('rejects %s with 400', async (query, error) => {
      const res = await server.get(`/templates/2/portfolios?${query}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error });
      expect(svc.listTemplatePortfolios).not.toHaveBeenCalled();
    });
  });
});
