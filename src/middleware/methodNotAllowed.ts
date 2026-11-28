import { Router, RequestHandler } from 'express';

/**
 * Attaches a catch-all handler to `router` for all HTTP methods not already
 * registered on a given path, returning 405 with a correct Allow header.
 *
 * Usage: call `attachMethodNotAllowed(router)` after all routes are defined.
 */
export function attachMethodNotAllowed(router: Router): void {
  // Express exposes the registered layer stack on the router object.
  // We walk that stack once per request to find which methods are registered
  // for the matched path, then respond 405 if the request method isn't among them.
  const handler: RequestHandler = (req, res) => {
    // Gather allowed methods from every layer whose regexp matches this path
    const allowed = new Set<string>();

    for (const layer of (router as unknown as { stack: RouterLayer[] }).stack) {
      if (!layer.route) continue;
      if (!layer.regexp.test(req.path)) continue;

      for (const method of Object.keys(layer.route.methods)) {
        allowed.add(method.toUpperCase());
      }
    }

    // GET implies HEAD
    if (allowed.has('GET')) allowed.add('HEAD');

    if (allowed.size === 0) {
      // Path doesn't match any route — fall through to 404 handler
      res.status(404).json({
        error: 'Route not found',
        path: req.originalUrl,
        requestId: req.id,
      });
      return;
    }

    const allowHeader = [...allowed].sort().join(', ');
    res.setHeader('Allow', allowHeader);
    res.status(405).json({
      error: `Method ${req.method} is not allowed on ${req.path}`,
      allow: allowHeader,
      requestId: req.id,
    });
  };

  router.all('*', handler);
}

type RouterLayer = {
  regexp: RegExp;
  route?: {
    methods: Record<string, boolean>;
  };
};
