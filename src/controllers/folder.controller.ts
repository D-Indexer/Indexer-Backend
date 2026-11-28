import { Request, Response } from 'express';
import * as folderService from '../services/folder';
import { folderNameSchema, stellarAddressSchema } from '../validation/schemas';
import { badRequest, notFound } from '../http/errors';

export const getByAddress = async (req: Request, res: Response): Promise<void> => {
  const address = req.params.address;
  const parsed = stellarAddressSchema.safeParse(address);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    throw badRequest(firstError ? firstError.message : 'Invalid address');
  }

  const query = atLedgerQuerySchema.safeParse(req.query);
  if (!query.success) throw badRequest(query.error.errors[0].message);

  const folder = await folderService.getFolderByAddress(parsed.data, query.data.atLedger);
  if (!folder) throw notFound('Folder not found');
  res.json(folder);
};

export const getByName = async (req: Request, res: Response): Promise<void> => {
  const name = req.params.name;
  const parsed = folderNameSchema.safeParse(name);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    throw badRequest(firstError ? firstError.message : 'Invalid folder name');
  }

  const query = atLedgerQuerySchema.safeParse(req.query);
  if (!query.success) throw badRequest(query.error.errors[0].message);

  const folder = await folderService.getFolderByName(parsed.data, query.data.atLedger);
  if (!folder) throw notFound('Folder not found');
  res.json(folder);
};
