import { Router } from 'express';
import multer from 'multer';
import * as ctrl from '../controllers/upload.controller';
import * as resumable from '../services/resumableUpload';
import { MAX_UPLOAD_BYTES } from '../validation/schemas';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 11 },
});

router.post('/', upload.single('file'), ctrl.upload);

// Resumable uploads (tus 1.0-compatible subset) — issue #210
const resumableChunk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 11 },
});

// Create a new resumable upload session.
router.post('/resumable', resumable.createUpload);

// Append a chunk at the current offset.
router.patch('/resumable/:id', resumableChunk.single('file'), resumable.patchUpload);

// Query the current offset / upload state.
router.head('/resumable/:id', resumable.headUpload);

// Explicit completion (also auto-completes when offset reaches total length).
router.post('/resumable/:id/complete', resumable.completeUpload);

export default router;