import { Router } from 'express';
import * as ctrl from '../controllers/portfolio.controller';

const router = Router();

router.post('/validate', ctrl.validateManifest);

router.get('/:address', ctrl.getByAddress);

export default router;