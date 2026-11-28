import { Router } from 'express';
import type { Queryable } from '../db/types';
import { createTemplateController } from '../controllers/template.controller';

export interface TemplateRoutesDeps {
  db: Queryable;
}

export function createTemplateRoutes(deps: TemplateRoutesDeps): Router {
  const router = Router();
  const ctrl = createTemplateController({ db: deps.db });

  router.get('/', ctrl.list);
  router.get('/:id', ctrl.getOne);
  router.get('/:id/portfolios', ctrl.listPortfolios);

  return router;
}

export default createTemplateRoutes;
