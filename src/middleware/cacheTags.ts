import { RequestHandler } from 'express';

/**
 * Sets the surrogate-key / cache-tag headers CDNs use to purge read responses.
 * Keys are the same ones the indexer purges after a page commits.
 */
export function cacheTags(...keys: string[]): RequestHandler {
  const value = keys.join(' ');
  return (_req, res, next) => {
    res.setHeader('Surrogate-Key', value);
    res.setHeader('Cache-Tag', value);
    next();
  };
}
