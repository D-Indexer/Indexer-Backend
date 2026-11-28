import type { Request, RequestHandler, Response } from 'express';
import type { Queryable } from '../db/types';
import * as templateService from '../services/template';
import { badRequest, notFound } from '../http/errors';
import { parsePageRequest } from '../http/pagination';
import { templateIdSchema } from '../validation/schemas';

export const list = async (_req: Request, res: Response): Promise<void> => {
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
};

export interface TemplateController {
  list: RequestHandler;
  getOne: RequestHandler;
  listPortfolios: RequestHandler;
}

export function parseTemplateId(rawId: unknown): number {
  if (typeof rawId !== 'string') throw badRequest('Template id is required');
  const parsed = templateIdSchema.safeParse(rawId);
  if (!parsed.success) {
    const firstIssue = parsed.error.errors[0];
    throw badRequest(firstIssue ? firstIssue.message : 'Invalid template id');
  }
  return parsed.data;
}

function parseSort(raw: unknown): templateService.TemplateSort {
  if (raw === undefined || raw === 'id') return 'id';
  if (raw === 'popular') return 'popular';
  throw badRequest("sort must be 'id' or 'popular'");
}

export function createTemplateController({ db }: TemplateControllerDeps): TemplateController {
  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const sort = parseSort(req.query['sort']);
      res.json(await templateService.listTemplates(db, sort));
    },

    getOne: async (req: Request, res: Response): Promise<void> => {
      const id = parseTemplateId(req.params['id']);
      const template = await templateService.getTemplate(db, id);
      if (!template) throw notFound('Template not found');
      res.json(template);
    },

  if (!template) throw notFound('Template not found');
  conditionalGet(resourceEtag(template.registeredAt), template.registeredAt, req, res);
  res.json(template);
};
