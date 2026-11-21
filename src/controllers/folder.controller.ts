import { Request, Response } from 'express';
import * as folderService from '../services/folder';
import { asyncHandler } from '../middleware/asyncHandler';
import { addressLookupSchema, folderListQuerySchema, folderNameSchema, stellarAddressSchema } from '../validation/schemas';
import { badRequest, notFound } from '../http/errors';
import { decodeCursor } from '../http/cursor';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const parsed = folderListQuerySchema.safeParse(req.query);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const { order, limit, cursor } = parsed.data;
  const page = await folderService.listFolders({
    order,
    limit,
    cursor: cursor === undefined ? undefined : decodeCursor(cursor, order),
  });
  res.json(page);
});

export const getByAddress = asyncHandler(async (req: Request, res: Response) => {
  const parsed = stellarAddressSchema.safeParse(req.params.address);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const folder = await folderService.getFolderByAddress(parsed.data);
  if (!folder) throw notFound('Folder not found');
  res.json(folder);
});

export const lookup = asyncHandler(async (req: Request, res: Response) => {
  const parsed = addressLookupSchema.safeParse(req.body);
  if (!parsed.success) {
    const details = parsed.error.errors.map((issue) => ({
      index: typeof issue.path[0] === 'number' ? issue.path[0] : null,
      address: typeof issue.path[0] === 'number' ? (req.body?.addresses?.[issue.path[0]] ?? null) : null,
      message: issue.message,
    }));
    throw badRequest(parsed.error.errors[0].message, details);
  }

  res.json(await folderService.getFoldersByAddresses(parsed.data.addresses));
});

export const getByName = asyncHandler(async (req: Request, res: Response) => {
  const parsed = folderNameSchema.safeParse(req.params.name);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const folder = await folderService.getFolderByName(parsed.data);
  if (!folder) throw notFound('Folder not found');
  res.json(folder);
});
