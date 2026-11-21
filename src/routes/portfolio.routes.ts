import { Router } from 'express';
import * as ctrl from '../controllers/portfolio.controller';

const router = Router();

router.post('/lookup', ctrl.lookup);
router.get('/:tokenId/metadata', ctrl.getMetadata);
router.get('/:address', ctrl.getByAddress);

export default router;
