import { Request, Response } from 'express';
import * as portfolioService from '../services/portfolio';
import { stellarAddressSchema } from '../validation/schemas';
import { badRequest, notFound } from '../http/errors';

export const getByAddress = async (req: Request, res: Response): Promise<void> => {
  const address = req.params.address;
  if (typeof address !== 'string') throw badRequest('Invalid address');

  const parsed = stellarAddressSchema.safeParse(address);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    throw badRequest(firstError ? firstError.message : 'Invalid address');
  }

  const portfolio = await portfolioService.getPortfolio(parsed.data);
  if (!portfolio) throw notFound('Portfolio not found');
  res.json(portfolio);
};