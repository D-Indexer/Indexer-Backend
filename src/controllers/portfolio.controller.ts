import { Request, Response } from 'express';
import * as portfolioService from '../services/portfolio';
import { stellarAddressSchema } from '../validation/schemas';
import { badRequest, notFound } from '../http/errors';
import { validateManifest } from '../validation/manifest';

export const getByAddress = async (req: Request, res: Response): Promise<void> => {
  const address = req.params.address;
  if (typeof address !== 'string') throw badRequest('Invalid address');

  const parsed = stellarAddressSchema.safeParse(address);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    throw badRequest(firstError ? firstError.message : 'Invalid address');
  }

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

  const portfolio = res.locals?.network
    ? await portfolioService.getPortfolio(parsed.data, res.locals.network)
    : await portfolioService.getPortfolio(parsed.data);
  if (!portfolio) throw notFound('Portfolio not found');
  conditionalGet(resourceEtag(portfolio.updatedAt), portfolio.updatedAt, req, res);
  res.json(portfolio);
};
