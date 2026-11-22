import { Router } from 'express';
import * as ctrl from '../controllers/template.controller';
import { attachMethodNotAllowed } from '../middleware/methodNotAllowed';

const router = Router();

router.get('/', ctrl.list);
router.get('/:id', ctrl.getOne);

attachMethodNotAllowed(router);

export default router;
