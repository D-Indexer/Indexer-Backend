import { Router } from 'express';
import multer from 'multer';
import * as ctrl from '../controllers/upload.controller';
import { MAX_UPLOAD_BYTES } from '../validation/schemas';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 11 },
});

router.post('/', upload.single('file'), ctrl.upload);

export default router;
