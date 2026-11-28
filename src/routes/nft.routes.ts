import { Router } from 'express';
import * as ctrl from '../controllers/portfolio.controller';

const router = Router();

router.get('/:tokenId/metadata', ctrl.getMetadata);

export default router;
