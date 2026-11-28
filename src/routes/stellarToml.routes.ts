import { Router, Request, Response } from 'express';
import { env } from '../config/env';

const router = Router();

/**
 * SEP-1 stellar.toml
 *
 * Served at /.well-known/stellar.toml so wallets can discover the
 * federation server (SEP-2) for `.folder` names.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md
 */
function buildStellarToml(): string {
  const lines: string[] = [];

  // Organisation info
  lines.push('# Stellar.toml for .folder names');
  lines.push('# SEP-1: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md');
  lines.push('');

  if (env.STELLAR_TOML_ORG_NAME) {
    lines.push(`ORG_NAME="${escapeTomlString(env.STELLAR_TOML_ORG_NAME)}"`);
  }
  if (env.STELLAR_TOML_ORG_URL) {
    lines.push(`ORG_URL="${escapeTomlString(env.STELLAR_TOML_ORG_URL)}"`);
  }
  if (env.STELLAR_TOML_ORG_EMAIL) {
    lines.push(`ORG_EMAIL="${escapeTomlString(env.STELLAR_TOML_ORG_EMAIL)}"`);
  }
  if (env.STELLAR_TOML_ORG_DESCRIPTION) {
    lines.push(`ORG_DESCRIPTION="${escapeTomlString(env.STELLAR_TOML_ORG_DESCRIPTION)}"`);
  }

  // Federation server (SEP-2)
  const federationServer = env.FEDERATION_SERVER_URL || `${env.PUBLIC_BASE_URL}/federation`;
  lines.push(`FEDERATION_SERVER="${escapeTomlString(federationServer)}"`);

  // Network passphrase
  if (env.STELLAR_NETWORK_PASSPHRASE) {
    lines.push(`NETWORK_PASSPHRASE="${escapeTomlString(env.STELLAR_NETWORK_PASSPHRASE)}"`);
  }

  lines.push('');
  return lines.join('\n');
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

router.get('/.well-known/stellar.toml', (_req: Request, res: Response) => {
  // SEP-1 requires permissive CORS so browser-based wallets can fetch the toml.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).send(buildStellarToml());
});

export default router;