import type { NextFunction, Request, Response } from 'express';
import { networkId, TESTNET_PASSPHRASE } from '../config/env';

export function networkMiddleware(defaultPassphrase: string) {
  const defaultNetwork = networkId(defaultPassphrase);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('x-stellar-network');
    const host = req.hostname || '';
    const subdomain = host.split('.')[0]?.toLowerCase();
    let passphrase = defaultPassphrase;
    if (header) passphrase = header;
    else if (subdomain === 'testnet') passphrase = TESTNET_PASSPHRASE;
    else if (req.path.startsWith('/testnet/')) passphrase = TESTNET_PASSPHRASE;
    res.locals.network = header && header.length === 64 ? header : networkId(passphrase);
    if (!res.locals.network) res.locals.network = defaultNetwork;
    next();
  };
}
