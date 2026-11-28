import { Router, type Request, type Response } from 'express';
import type { Queryable } from '../db/types';
import { badRequest } from '../http/errors';
import { parsePageRequest } from '../http/pagination';
import { getCreatorStats, listTemplatesByCreator } from '../services/template';
import { stellarAddressSchema } from '../validation/schemas';

export interface CreatorRoutesDeps {
  db: Queryable;
}

function parseAddress(raw: unknown): string {
  const parsed = stellarAddressSchema.safeParse(raw);
  if (!parsed.success) throw badRequest('Invalid Stellar address');
  return parsed.data;
}

/**
 * Template creators, as attributed by `tmpl_reg`. A creator is just an
 * address: there is no creator registry, so unknown addresses return empty
 * results (zero stats, empty list) rather than 404.
 */
export function createCreatorRoutes({ db }: CreatorRoutesDeps): Router {
  const router = Router();

  router.get('/:address', async (req: Request, res: Response) => {
    const address = parseAddress(req.params['address']);
    res.json(await getCreatorStats(db, address));
  });

  router.get('/:address/templates', async (req: Request, res: Response) => {
    const address = parseAddress(req.params['address']);
    const page = parsePageRequest(req.query, 2);
    const { items, nextCursor } = await listTemplatesByCreator(db, address, page);
    res.json({ templates: items, nextCursor });
  });

  return router;
}

export default createCreatorRoutes;
