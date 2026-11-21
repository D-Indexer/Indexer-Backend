import { Request, Response } from 'express';
import * as templateService from '../services/template';
import { asyncHandler } from '../middleware/asyncHandler';
import { badRequest, notFound } from '../http/errors';
import { templateIdSchema } from '../validation/schemas';

import { collectionEtag, conditionalGet, resourceEtag } from '../middleware/conditionalGet';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const templates = await templateService.listTemplates();
  const newest = templates.reduce<Date | null>(
    (acc, template) => (acc === null || template.registeredAt > acc ? template.registeredAt : acc),
    null
  );
  conditionalGet(
    collectionEtag(templates.map((template) => ({ marker: template.registeredAt }))),
    newest,
    req,
    res
  );
  res.json(templates);
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const parsed = templateIdSchema.safeParse(req.params.id);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const template = await templateService.getTemplate(parsed.data);
  if (!template) throw notFound('Template not found');
  conditionalGet(resourceEtag(template.registeredAt), template.registeredAt, req, res);
  res.json(template);
});
