import multer from 'multer';
import { ErrorRequestHandler } from 'express';
import { badRequest } from '../http/errors';

export const multerErrorHandler: ErrorRequestHandler = (err, _req, _res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      next(badRequest('File exceeds 10 MB limit'));
      return;
    }

    next(badRequest(err.message));
    return;
  }

  next(err);
};
