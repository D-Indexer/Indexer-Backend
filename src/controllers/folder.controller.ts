import { Request, Response } from 'express';
import * as folderService from '../services/folder';
import { asyncHandler } from '../middleware/asyncHandler';
import { folderNameSchema, stellarAddressSchema } from '../validation/schemas';
import { badRequest, notFound } from '../http/errors';

export const getByAddress = asyncHandler(async (req: Request, res: Response) => {
  const parsed = stellarAddressSchema.safeParse(req.params.address);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const folder = await folderService.getFolderByAddress(parsed.data);
  if (!folder) throw notFound('Folder not found');
  res.json(folder);
});

export const getByName = asyncHandler(async (req: Request, res: Response) => {
  const parsed = folderNameSchema.safeParse(req.params.name);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const folder = await folderService.getFolderByName(parsed.data);
  if (!folder) throw notFound('Folder not found');
  res.json(folder);
});

export const getCredentials = asyncHandler(async (req: Request, res: Response) => {
  const parsed = stellarAddressSchema.safeParse(req.params.address);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const credentials = await folderService.getCredentials(parsed.data);
  res.json(credentials);
});
