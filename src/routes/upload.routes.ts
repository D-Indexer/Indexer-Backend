import { Router } from 'express';
import multer from 'multer';
import * as ctrl from '../controllers/upload.controller';
import { MAX_UPLOAD_BYTES } from '../validation/schemas';
import { uploadSemaphore } from '../middleware/uploadSemaphore';
import { env } from '../config/env';

const router = Router();

// Acquire a global upload slot before multer starts buffering the body.
// When saturated, respond 503 with Retry-After without reading the body.
router.use(uploadSemaphore);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 11 },
});

const bundleUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: env.UPLOAD_BUNDLE_MAX_FILES,
    fields: 10,
    parts: env.UPLOAD_BUNDLE_MAX_FILES + 10,
  },
});

router.post('/', upload.single('file'), ctrl.upload);

router.post(
  '/bundle',
  bundleUpload.fields([
    { name: 'files', maxCount: env.UPLOAD_BUNDLE_MAX_FILES },
    { name: 'manifest', maxCount: 1 },
  ]),
  ctrl.uploadBundle,
);

export default router;