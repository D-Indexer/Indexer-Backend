import { Router } from 'express';
import * as ctrl from '../controllers/folder.controller';
import { attachMethodNotAllowed } from '../middleware/methodNotAllowed';

const router = Router();

// /name/:name/availability must be registered before /name/:name to avoid shadowing
router.get('/name/:name/availability', ctrl.checkNameAvailability);
// /name/:name must be registered before /:address to avoid wildcard shadowing
router.get('/name/:name', ctrl.getByName);
router.get('/:address', ctrl.getByAddress);

attachMethodNotAllowed(router);

export default router;
