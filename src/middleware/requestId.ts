import { randomUUID } from 'crypto';
import { RequestHandler } from 'express';

declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && incoming.trim().length > 0 ? incoming : randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
};
