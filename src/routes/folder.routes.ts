import { Router } from 'express';
import { createFolderController } from '../controllers/folder.controller';
import type { FolderService } from '../services/folder.service';

export interface FolderRoutesDeps {
  folderService: FolderService;
}

export function createFolderRoutes(deps: FolderRoutesDeps): Router {
  const router = Router();
  const ctrl = createFolderController({ folderService: deps.folderService });

// Express 5 note: named params like /:address are supported as-is.
// Future wildcard routes must use the new path-to-regexp syntax, e.g. '/*splat'
// (the legacy '*' / ':param*' forms are no longer valid in Express 5).

attachMethodNotAllowed(router);

export default router;
