import { Router } from 'express';
import * as ctrl from '../controllers/portfolio.controller';

const router = Router();

router.get('/:address', ctrl.getByAddress);

export default router;
