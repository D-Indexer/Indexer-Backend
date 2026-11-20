import { Request, Response } from 'express';
import * as portfolioService from '../services/portfolio';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  stellarAddressSchema,
  cidSchema,
  atLedgerSchema,
  versionsQuerySchema,
  byCidQuerySchema,
} from '../validation/schemas';
import { badRequest, notFound } from '../http/errors';

export const getByAddress = asyncHandler(async (req: Request, res: Response) => {
  const parsed = stellarAddressSchema.safeParse(req.params.address);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const ledgerParsed = atLedgerSchema.safeParse(req.query.atLedger);
  if (!ledgerParsed.success) throw badRequest(ledgerParsed.error.errors[0].message);

  const atLedger = ledgerParsed.data;

  if (atLedger !== undefined) {
    const result = await portfolioService.getPortfolioAtLedger(parsed.data, atLedger);
    if (result === null) throw notFound('Portfolio not found');
    if (result === 'out_of_range') {
      throw badRequest(
        `atLedger ${atLedger} is outside the indexed ledger range`,
      );
    }
    res.json(result);
    return;
  }

  const portfolio = await portfolioService.getPortfolio(parsed.data);
  if (!portfolio) throw notFound('Portfolio not found');
  res.json(portfolio);
});

export const getVersions = asyncHandler(async (req: Request, res: Response) => {
  const parsed = stellarAddressSchema.safeParse(req.params.address);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const queryParsed = versionsQuerySchema.safeParse(req.query);
  if (!queryParsed.success) throw badRequest(queryParsed.error.errors[0].message);

  const { limit, cursor } = queryParsed.data;

  const result = await portfolioService.getPortfolioVersions(parsed.data, {
    limit,
    cursor,
  });

  res.json(result);
});

export const getByCid = asyncHandler(async (req: Request, res: Response) => {
  const parsed = cidSchema.safeParse(req.params.cid);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const queryParsed = byCidQuerySchema.safeParse(req.query);
  if (!queryParsed.success) throw badRequest(queryParsed.error.errors[0].message);

  const { includeHistorical } = queryParsed.data;

  const result = await portfolioService.getPortfoliosByCid(parsed.data, {
    includeHistorical,
  });

  res.json(result);
});