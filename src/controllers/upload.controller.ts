import { Request, Response } from 'express';
import { pinFile } from '../services/ipfs';
import { uploadFileSchema } from '../validation/schemas';
import { sniffContentType } from '../validation/fileType';
import { validateImageDimensions } from '../validation/imageDimensions';
import { validatePdf } from '../validation/pdf';
import { badRequest } from '../http/errors';

export const upload = async (req: Request, res: Response): Promise<void> => {
  const file = req.file;
  if (!file) throw badRequest('No file provided');

  const result = uploadFileSchema.safeParse({ mimetype: file.mimetype, size: file.size });
  if (!result.success) {
    const firstError = result.error.errors[0];
    throw badRequest(firstError ? firstError.message : 'Invalid file');
  }

  await validateFileContent(file.buffer, file.mimetype, file.originalname);

  const cid = await pinFile(file.buffer, file.originalname);
  res.json({ cid });
};
