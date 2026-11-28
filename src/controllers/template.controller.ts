import { Request, Response } from 'express';
import * as templateService from '../services/template';
import { badRequest, notFound } from '../http/errors';
import { templateIdSchema } from '../validation/schemas';

export const list = async (_req: Request, res: Response): Promise<void> => {
  const templates = await templateService.listTemplates();
  res.json(templates);
};

export const getOne = async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  if (rawId === undefined) throw badRequest('Template id is required');

  const parsed = templateIdSchema.safeParse(rawId);
  if (!parsed.success) {
    const firstIssue = parsed.error.errors[0];
    throw badRequest(firstIssue ? firstIssue.message : 'Invalid template id');
  }

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
};
