import { Request, Response } from 'express';
import { pinFile } from '../services/ipfs';
import { asyncHandler } from '../middleware/asyncHandler';
import { uploadFileSchema } from '../validation/schemas';
import { badRequest } from '../http/errors';

export const upload = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw badRequest('No file provided');

  const result = uploadFileSchema.safeParse({ mimetype: file.mimetype, size: file.size });
  if (!result.success) throw badRequest(result.error.errors[0].message);

  const cid = await pinFile(file.buffer, file.originalname);
  res.json({ cid });
});
