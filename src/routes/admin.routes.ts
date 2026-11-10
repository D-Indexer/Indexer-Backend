import { Router } from 'express';
import * as ctrl from '../controllers/admin.controller';

const router = Router();

router.get('/', ctrl.list);

export default router;
