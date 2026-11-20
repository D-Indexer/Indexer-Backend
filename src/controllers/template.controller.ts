import { Request, Response } from 'express';
import * as templateService from '../services/template';
import { asyncHandler } from '../middleware/asyncHandler';
import { badRequest, notFound } from '../http/errors';
import { templateIdSchema } from '../validation/schemas';

const parseAtLedger = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw badRequest('atLedger must be a non-negative integer');
  }
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    throw badRequest('atLedger must be a non-negative integer');
  }
  const parsed = Number(str);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw badRequest('atLedger must be a non-negative integer');
  }
  return parsed;
};

const parseLimit = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    throw badRequest('limit must be a positive integer');
  }
  const parsed = Number(str);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw badRequest('limit must be a positive integer');
  }
  return parsed;
};

const parseCursor = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    throw badRequest('cursor must be a non-negative integer');
  }
  const parsed = Number(str);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw badRequest('cursor must be a non-negative integer');
  }
  return parsed;
};

const isOutOfRangeError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { code?: unknown; status?: unknown; name?: unknown };
  return (
    anyErr.code === 'LEDGER_OUT_OF_RANGE' ||
    anyErr.name === 'LedgerOutOfRangeError' ||
    anyErr.status === 400
  );
};

export const list = asyncHandler(async (_req: Request, res: Response) => {
  const templates = await templateService.listTemplates();
  res.json(templates);
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const parsed = templateIdSchema.safeParse(req.params.id);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const atLedger = parseAtLedger(req.query.atLedger);

  let template;
  try {
    template = await templateService.getTemplate(parsed.data, atLedger);
  } catch (err) {
    if (isOutOfRangeError(err)) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'atLedger is outside the indexed ledger range';
      throw badRequest(message);
    }
    throw err;
  }

  if (!template) throw notFound('Template not found');
  res.json(template);
});

export const getVersions = asyncHandler(async (req: Request, res: Response) => {
  const parsed = templateIdSchema.safeParse(req.params.id);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const limit = parseLimit(req.query.limit);
  const cursor = parseCursor(req.query.cursor);

  const result = await templateService.getTemplateVersions(parsed.data, {
    limit,
    cursor,
  });

  if (!result) throw notFound('Template not found');
  res.json(result);
});