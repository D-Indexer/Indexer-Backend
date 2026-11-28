import { Request, Response } from 'express';
import * as eventService from '../services/event';
import { asyncHandler } from '../middleware/asyncHandler';
import { badRequest, notFound } from '../http/errors';
import { eventIdSchema, eventListQuerySchema } from '../validation/schemas';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const parsed = eventListQuerySchema.safeParse(req.query);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const { fromLedger, toLedger } = parsed.data;
  if (fromLedger !== undefined && toLedger !== undefined && fromLedger > toLedger) {
    throw badRequest('fromLedger must be less than or equal to toLedger');
  }

  const page = await eventService.listEvents(parsed.data);
  res.json(page);
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const parsed = eventIdSchema.safeParse(req.params.id);
  if (!parsed.success) throw badRequest(parsed.error.errors[0].message);

  const event = await eventService.getEvent(parsed.data);
  if (!event) throw notFound('Event not found');
  res.json(event);
});
