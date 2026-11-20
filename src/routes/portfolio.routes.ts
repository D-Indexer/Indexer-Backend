import { Router } from 'express';
import * as ctrl from '../controllers/portfolio.controller';

const router = Router();

// Static / more specific routes must be registered before the wildcard
// `/:address` route to avoid shadowing.
router.get('/by-cid/:cid', ctrl.getByCid);
router.get('/:address/versions', ctrl.getVersions);
router.get('/:address', ctrl.getByAddress);

export default router;