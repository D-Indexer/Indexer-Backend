import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { MAX_UPLOAD_BYTES } from '../validation/schemas';
import type { FeatureFlagChecker } from '../featureFlags';

export interface UploadRoutesDeps {
  ipfs: {
    upload: (file: Express.Multer.File) => Promise<{ cid: string; size: number }>;
  };
  featureFlags: FeatureFlagChecker;
}

export function createUploadRoutes(deps: UploadRoutesDeps): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 11 },
  });

  const requireUploadsEnabled = async (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const enabled = await deps.featureFlags.isEnabled('uploads');
      if (!enabled) {
        res.status(503).json({
          error: 'feature_disabled',
          message: 'Uploads are temporarily disabled. Please try again later.',
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  const handleUpload = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({
          error: 'no_file',
          message: 'No file was provided in the request.',
        });
        return;
      }
      const result = await deps.ipfs.upload(req.file);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  router.post('/', requireUploadsEnabled, upload.single('file'), handleUpload);

  return router;
}

export default createUploadRoutes;