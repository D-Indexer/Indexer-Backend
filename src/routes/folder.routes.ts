import { Router } from 'express';
import * as ctrl from '../controllers/folder.controller';

const router = Router();

// /name/:name must be registered before /:address to avoid wildcard shadowing
router.get('/name/:name', ctrl.getByName);
router.get('/:address', ctrl.getByAddress);

// Express 5 note: named params like /:address are supported as-is.
// Future wildcard routes must use the new path-to-regexp syntax, e.g. '/*splat'
// (the legacy '*' / ':param*' forms are no longer valid in Express 5).

export default router;