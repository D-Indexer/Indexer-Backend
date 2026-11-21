import { Router } from 'express';
import * as ctrl from '../controllers/folder.controller';

const router = Router();

// /lookup must be registered before /:address to avoid wildcard shadowing
router.post('/lookup', ctrl.lookup);
router.get('/name/:name', ctrl.getByName);
router.get('/:address', ctrl.getByAddress);

export default router;
