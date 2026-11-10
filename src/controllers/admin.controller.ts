import { Request, Response } from 'express';
import * as adminService from '../services/admin';
import { asyncHandler } from '../middleware/asyncHandler';

export const list = asyncHandler(async (_req: Request, res: Response) => {
  const admins = await adminService.listAdmins();
  res.json(admins);
});
