import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { folderService } from '../services/folder.service';
import { logger } from '../utils/logger';

/**
 * SEP-2 Federation server implementation.
 *
 * Supports:
 *  - Forward lookups:  GET /federation?type=name&q=<name>*<domain>
 *  - Reverse lookups:  GET /federation?type=id&q=<account_id>
 *
 * Name normalisation:
 *  - Federation names are of the form `<name>*<domain>`.
 *  - `.folder` names are stored lowercased and trimmed. The federation
 *    `<name>` portion is normalised by lowercasing and trimming, matching
 *    the stored representation. The `<domain>` portion is lowercased.
 *  - Only the configured federation domain (FEDERATION_DOMAIN) is accepted
 *    for forward lookups; other domains return 404.
 *
 * Responses follow SEP-2:
 *  - Success: `{ stellar_address, account_id }`
 *  - Not found: HTTP 404 with `{ detail: "..." }`
 *  - Bad input: HTTP 400 with `{ detail: "..." }`
 */

const FEDERATION_DOMAIN = (process.env.FEDERATION_DOMAIN || 'folder').toLowerCase();

const querySchema = z.object({
  type: z.enum(['name', 'id']),
  q: z.string().min(1, 'q is required'),
});

const FEDERATION_CACHE_CONTROL = 'public, max-age=60';

interface FederationResponse {
  stellar_address: string;
  account_id: string;
}

function setFederationHeaders(res: Response): void {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', FEDERATION_CACHE_CONTROL);
}

function sendError(res: Response, status: number, detail: string): void {
  setFederationHeaders(res);
  res.status(status).json({ detail });
}

/**
 * Normalise a federation name (`<name>*<domain>`) into its components.
 * Returns null if the format is invalid.
 */
function parseFederationName(
  q: string,
): { name: string; domain: string } | null {
  const trimmed = q.trim();
  const starIndex = trimmed.indexOf('*');
  if (starIndex <= 0 || starIndex === trimmed.length - 1) {
    return null;
  }
  const name = trimmed.slice(0, starIndex).trim().toLowerCase();
  const domain = trimmed.slice(starIndex + 1).trim().toLowerCase();
  if (!name || !domain) {
    return null;
  }
  return { name, domain };
}

/**
 * Normalise a `.folder` name for lookup. `.folder` names are stored
 * lowercased; strip an optional trailing `.folder` suffix if present.
 */
function normaliseFolderName(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.endsWith('.folder') ? lower.slice(0, -'.folder'.length) : lower;
}

async function handleForwardLookup(
  res: Response,
  q: string,
): Promise<void> {
  const parsed = parseFederationName(q);
  if (!parsed) {
    sendError(res, 400, 'Invalid federation address format; expected <name>*<domain>');
    return;
  }

  if (parsed.domain !== FEDERATION_DOMAIN) {
    // Unknown domain: per SEP-2, treat as not found.
    sendError(res, 404, 'Federation address not found');
    return;
  }

  const folderName = normaliseFolderName(parsed.name);

  try {
    const folder = await folderService.getByName(folderName);
    if (!folder || !folder.stellarAddress) {
      sendError(res, 404, 'Federation address not found');
      return;
    }

    const body: FederationResponse = {
      stellar_address: `${folderName}*${FEDERATION_DOMAIN}`,
      account_id: folder.stellarAddress,
    };
    setFederationHeaders(res);
    res.status(200).json(body);
  } catch (err) {
    logger.error('Federation forward lookup failed', { error: err, q });
    sendError(res, 500, 'Internal server error');
  }
}

async function handleReverseLookup(res: Response, q: string): Promise<void> {
  const accountId = q.trim();
  if (!accountId) {
    sendError(res, 400, 'Invalid account id');
    return;
  }

  try {
    const folder = await folderService.getByStellarAddress(accountId);
    if (!folder) {
      sendError(res, 404, 'Account not found');
      return;
    }

    const body: FederationResponse = {
      stellar_address: `${folder.name.toLowerCase()}*${FEDERATION_DOMAIN}`,
      account_id: accountId,
    };
    setFederationHeaders(res);
    res.status(200).json(body);
  } catch (err) {
    logger.error('Federation reverse lookup failed', { error: err, q });
    sendError(res, 500, 'Internal server error');
  }
}

export function createFederationRouter(): Router {
  const router = Router();

  router.get('/federation', async (req: Request, res: Response) => {
    const result = querySchema.safeParse(req.query);
    if (!result.success) {
      sendError(res, 400, 'Invalid query parameters; expected type and q');
      return;
    }

    const { type, q } = result.data;

    if (type === 'name') {
      await handleForwardLookup(res, q);
    } else {
      await handleReverseLookup(res, q);
    }
  });

  return router;
}

export const federationRouter = createFederationRouter();
```

Note: This file assumes `folderService` exposes `getByName(name)` and `getByStellarAddress(address)` methods, and that `logger` is available at `../utils/logger`. If the existing service uses different method names (e.g. `findByName`, `findByStellarAddress`), adjust the calls accordingly. The route must be registered in `app.ts` via `app.use(federationRouter)` (or `app.use('/', federationRouter)`) so that `GET /federation` is served at the root path.