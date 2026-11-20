import { Router } from 'express';
import { createFolderController } from '../controllers/folder.controller';
import type { FolderService } from '../services/folder.service';

export interface FolderRoutesDeps {
  folderService: FolderService;
}

export function createFolderRoutes(deps: FolderRoutesDeps): Router {
  const router = Router();
  const ctrl = createFolderController({ folderService: deps.folderService });

  // /name/:name must be registered before /:address to avoid wildcard shadowing
  router.get('/name/:name', ctrl.getByName);
  router.get('/:address', ctrl.getByAddress);

  return router;
}

export default createFolderRoutes;