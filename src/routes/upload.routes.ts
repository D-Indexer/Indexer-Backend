import { Router } from 'express';
import multer from 'multer';
import * as ctrl from '../controllers/upload.controller';
import { MAX_UPLOAD_BYTES } from '../validation/schemas';
import { idempotency } from '../middleware/idempotency';
import { attachMethodNotAllowed } from '../middleware/methodNotAllowed';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 11 },
});

// multer runs first so req.file (and its buffer) is available when idempotency middleware executes
router.post('/', upload.single('file'), idempotency(), ctrl.upload);

attachMethodNotAllowed(router);

export default router;
