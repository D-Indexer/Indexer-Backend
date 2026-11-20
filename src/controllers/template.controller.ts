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

  const template = await templateService.getTemplate(parsed.data);
  if (!template) throw notFound('Template not found');
  res.json(template);
};