import { Request, Response } from 'express';
import * as portfolioService from '../services/portfolio';
import { asyncHandler } from '../middleware/asyncHandler';
import { stellarAddressSchema } from '../validation/schemas';
import { badRequest, notFound } from '../http/errors';

export const getByAddress = asyncHandler(async (req: Request, res: Response) => {
  const parsed = stellarAddressSchema.safeParse(req.params.address);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const portfolio = await portfolioService.getPortfolio(parsed.data);
  if (!portfolio) throw notFound('Portfolio not found');
  res.json(portfolio);
});
