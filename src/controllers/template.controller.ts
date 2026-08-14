import { Request, Response } from 'express';
import * as templateService from '../services/template';
import { asyncHandler } from '../middleware/asyncHandler';
import { badRequest, notFound } from '../http/errors';
import { templateIdSchema } from '../validation/schemas';

export const list = asyncHandler(async (_req: Request, res: Response) => {
  const templates = await templateService.listTemplates();
  res.json(templates);
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const parsed = templateIdSchema.safeParse(req.params.id);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const template = await templateService.getTemplate(Number(parsed.data));
  if (!template) throw notFound('Template not found');
  res.json(template);
});
