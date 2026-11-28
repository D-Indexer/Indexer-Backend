import * as templateService from '../services/template';
import { decodeCursor, encodeCursor } from '../http/pagination';

function fakeDb(rows: unknown[] = []) {
  return { query: jest.fn().mockResolvedValue({ rows }) } as any;
}

const registeredAt = new Date('2026-11-09T22:14:42.000Z');
const templateRow = {
  id: '1',
  metadata_uri: 'ipfs://bafy',
  creator: 'GADMIN',
  registered_at: registeredAt,
  usage_count: '7',
};

function portfolioRow(owner: string, ts: string) {
  return {
    owner,
    template_id: '1',
    ipfs_cid: 'bafkcid',
    minted_at: new Date(ts),
    updated_at: new Date(ts),
    cursor_ts: ts.replace('Z', '000Z'),
  };
}

describe('template service', () => {
  it('lists templates in id order with usageCount from the counter table', async () => {
    const db = fakeDb([templateRow]);

    const result = await templateService.listTemplates(db);

    expect(db.query).toHaveBeenCalledWith(templateService.LIST_TEMPLATES_SQL);
    expect(templateService.LIST_TEMPLATES_SQL).toContain('LEFT JOIN template_usage');
    expect(templateService.LIST_TEMPLATES_SQL).toMatch(/ORDER BY t\.id$/);
    expect(result).toEqual([
      { id: 1, metadataUri: 'ipfs://bafy', creator: 'GADMIN', registeredAt, usageCount: 7 },
    ]);
  });

  it('lists templates by popularity when sort=popular', async () => {
    const db = fakeDb([]);
    await templateService.listTemplates(db, 'popular');
    expect(db.query).toHaveBeenCalledWith(templateService.LIST_POPULAR_TEMPLATES_SQL);
    expect(templateService.LIST_POPULAR_TEMPLATES_SQL).toMatch(/portfolio_count, 0\) DESC, t\.id$/);
  });

  it('reports usageCount 0 for templates no portfolio uses', async () => {
    const db = fakeDb([{ ...templateRow, usage_count: '0' }]);
    await expect(templateService.getTemplate(db, 1)).resolves.toMatchObject({ usageCount: 0 });
  });

  it('returns null when template is missing', async () => {
    const db = fakeDb([]);
    await expect(templateService.getTemplate(db, 9)).resolves.toBeNull();
    expect(db.query).toHaveBeenCalledWith(templateService.GET_TEMPLATE_SQL, [9]);
  });

  describe('listTemplatePortfolios', () => {
    it('fetches limit + 1 and returns a cursor of the last row when there are more', async () => {
      const db = fakeDb([
        portfolioRow('GB', '2026-11-09T22:00:02.000Z'),
        portfolioRow('GA', '2026-11-09T22:00:01.000Z'),
        portfolioRow('GZ', '2026-11-09T22:00:00.000Z'),
      ]);

      const page = await templateService.listTemplatePortfolios(db, 1, { limit: 2, after: null });

      expect(db.query).toHaveBeenCalledWith(templateService.LIST_TEMPLATE_PORTFOLIOS_SQL, [1, 3]);
      expect(page.items.map((p) => p.owner)).toEqual(['GB', 'GA']);
      expect(page.items[0]).toEqual({
        owner: 'GB',
        templateId: 1,
        ipfsCid: 'bafkcid',
        mintedAt: new Date('2026-11-09T22:00:02.000Z'),
        updatedAt: new Date('2026-11-09T22:00:02.000Z'),
      });
      expect(page.nextCursor).not.toBeNull();
      expect(decodeCursor(page.nextCursor as string, 2)).toEqual(['2026-11-09T22:00:01.000000Z', 'GA']);
    });

    it('returns a null cursor on the last page', async () => {
      const db = fakeDb([portfolioRow('GA', '2026-11-09T22:00:01.000Z')]);
      const page = await templateService.listTemplatePortfolios(db, 1, { limit: 2, after: null });
      expect(page.nextCursor).toBeNull();
    });

    it('continues strictly after the cursor key', async () => {
      const db = fakeDb([]);
      const after = decodeCursor(encodeCursor(['2026-11-09T22:00:01.000000Z', 'GA']), 2);

      await templateService.listTemplatePortfolios(db, 5, { limit: 10, after });

      expect(db.query).toHaveBeenCalledWith(templateService.LIST_TEMPLATE_PORTFOLIOS_AFTER_SQL, [
        5,
        11,
        '2026-11-09T22:00:01.000000Z',
        'GA',
      ]);
      expect(templateService.LIST_TEMPLATE_PORTFOLIOS_AFTER_SQL).toContain(
        '(updated_at, owner) < ($3::timestamptz, $4)'
      );
    });
  });
});
