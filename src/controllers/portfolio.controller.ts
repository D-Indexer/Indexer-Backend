import { Request, Response } from 'express';
import * as portfolioService from '../services/portfolio';
import { asyncHandler } from '../middleware/asyncHandler';
import { addressLookupSchema, stellarAddressSchema, tokenIdSchema } from '../validation/schemas';
import { badRequest, notFound } from '../http/errors';

export const getByAddress = asyncHandler(async (req: Request, res: Response) => {
  const parsed = stellarAddressSchema.safeParse(req.params.address);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const portfolio = await portfolioService.getPortfolio(parsed.data);
  if (!portfolio) throw notFound('Portfolio not found');
  res.json(portfolio);
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

  res.json(await portfolioService.getPortfoliosByAddresses(parsed.data.addresses));
});

export const getMetadata = asyncHandler(async (req: Request, res: Response) => {
  const parsed = tokenIdSchema.safeParse(req.params.tokenId);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const metadata = await portfolioService.getPortfolioMetadata(parsed.data);
  if (!metadata) throw notFound('Token not found');

  // Metadata is immutable per token id until the portfolio is updated; let
  // clients and gateways cache it briefly.
  res.set('Cache-Control', 'public, max-age=60');
  res.json(metadata);
});
