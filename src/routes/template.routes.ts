import { Router } from 'express';
import { createTemplateController } from '../controllers/template.controller';
import type { TemplateService } from '../services/template.service';

export interface TemplateRoutesDeps {
  templateService: TemplateService;
}

export function createTemplateRoutes(deps: TemplateRoutesDeps): Router {
  const router = Router();
  const ctrl = createTemplateController({ templateService: deps.templateService });

  router.get('/', ctrl.list);
  router.get('/:id', ctrl.getOne);

  return router;
}

export default createTemplateRoutes;
