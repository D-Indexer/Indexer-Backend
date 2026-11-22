import { Router } from 'express';
import * as ctrl from '../controllers/portfolio.controller';
import { attachMethodNotAllowed } from '../middleware/methodNotAllowed';

const router = Router();

router.get('/:address', ctrl.getByAddress);

attachMethodNotAllowed(router);

export default router;
