import pool from '../db/client';
import { Portfolio } from '../types';

type PortfolioRow = {
  owner: string;
  template_id: string;
  ipfs_cid: string;
  minted_at: Date;
  updated_at: Date;
};

type PortfolioVersionRow = {
  owner: string;
  version: number;
  ipfs_cid: string;
  template_id: string;
  event_id: string | null;
  at: Date;
};

type PortfolioAtLedgerRow = PortfolioRow & {
  from_ledger: number;
  to_ledger: number | null;
};

export type PortfolioVersion = {
  owner: string;
  version: number;
  ipfsCid: string;
  templateId: number;
  eventId: string | null;
  at: Date;
};

export type PortfolioAtLedger = Portfolio & {
  fromLedger: number;
  toLedger: number | null;
};

export type CidReference = {
  owner: string;
  ipfsCid: string;
  templateId: number;
  version: number | null;
  historical: boolean;
  at: Date;
};

export type PageOptions = {
  limit?: number;
  cursor?: string | null;
};

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

export class InvalidLedgerError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'INVALID_LEDGER';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerError';
  }
}

export class InvalidCidError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'INVALID_CID';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidCidError';
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function mapPortfolio(row: PortfolioRow): Portfolio {
  return {
    owner: row.owner,
    templateId: Number(row.template_id),
    ipfsCid: row.ipfs_cid,
    mintedAt: row.minted_at,
    updatedAt: row.updated_at,
  };
}

function mapPortfolioVersion(row: PortfolioVersionRow): PortfolioVersion {
  return {
    owner: row.owner,
    version: Number(row.version),
    ipfsCid: row.ipfs_cid,
    templateId: Number(row.template_id),
    eventId: row.event_id,
    at: row.at,
  };
}

function mapPortfolioAtLedger(row: PortfolioAtLedgerRow): PortfolioAtLedger {
  return {
    ...mapPortfolio(row),
    fromLedger: Number(row.from_ledger),
    toLedger: row.to_ledger === null ? null : Number(row.to_ledger),
  };
}

function normaliseLimit(limit?: number): number {
  if (limit === undefined || limit === null || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }
  const n = Math.floor(limit);
  if (n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function encodeVersionCursor(version: number): string {
  return Buffer.from(`v:${version}`, 'utf8').toString('base64url');
}

function decodeVersionCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^v:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return Number(match[1]);
  } catch {
    throw new InvalidLedgerError('Invalid pagination cursor');
  }
}

export async function getPortfolio(owner: string): Promise<Portfolio | null> {
  const { rows } = await pool.query<PortfolioRow>(
    'SELECT owner, template_id, ipfs_cid, minted_at, updated_at FROM portfolios WHERE owner = $1',
    [owner]
  );
  return rows[0] ? mapPortfolio(rows[0]) : null;
}

export async function listPortfolioVersions(
  owner: string,
  options: PageOptions = {}
): Promise<Page<PortfolioVersion>> {
  const limit = normaliseLimit(options.limit);
  const afterVersion = options.cursor ? decodeVersionCursor(options.cursor) : null;

  const params: unknown[] = [owner];
  let where = 'owner = $1';
  if (afterVersion !== null) {
    params.push(afterVersion);
    where += ` AND version < $${params.length}`;
  }
  params.push(limit + 1);

  const { rows } = await pool.query<PortfolioVersionRow>(
    `SELECT owner, version, ipfs_cid, template_id, event_id, at
       FROM portfolio_versions
      WHERE ${where}
      ORDER BY version DESC
      LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(mapPortfolioVersion);
  const nextCursor =
    hasMore && items.length > 0 ? encodeVersionCursor(items[items.length - 1].version) : null;

  return { items, nextCursor };
}

async function getIndexedLedgerRange(): Promise<{ min: number | null; max: number | null }> {
  const { rows } = await pool.query<{ min_ledger: string | null; max_ledger: string | null }>(
    `SELECT MIN(from_ledger) AS min_ledger, MAX(COALESCE(to_ledger, from_ledger)) AS max_ledger
       FROM portfolio_versions`
  );
  const row = rows[0];
  const min = row?.min_ledger === null || row?.min_ledger === undefined ? null : Number(row.min_ledger);
  const max = row?.max_ledger === null || row?.max_ledger === undefined ? null : Number(row.max_ledger);
  return { min, max };
}

export async function getPortfolioAtLedger(
  owner: string,
  ledger: number
): Promise<PortfolioAtLedger | null> {
  if (!Number.isInteger(ledger) || ledger < 0) {
    throw new InvalidLedgerError('atLedger must be a non-negative integer');
  }

  const { min, max } = await getIndexedLedgerRange();
  if (min === null || max === null) {
    throw new InvalidLedgerError('No indexed ledgers available');
  }
  if (ledger < min) {
    throw new InvalidLedgerError(
      `atLedger ${ledger} is before the earliest indexed ledger (${min})`
    );
  }
  if (ledger > max) {
    throw new InvalidLedgerError(
      `atLedger ${ledger} is after the last indexed ledger (${max})`
    );
  }

  const { rows } = await pool.query<PortfolioAtLedgerRow>(
    `SELECT owner, template_id, ipfs_cid, minted_at, updated_at, from_ledger, to_ledger
       FROM portfolio_versions
      WHERE owner = $1
        AND from_ledger <= $2
        AND (to_ledger IS NULL OR to_ledger > $2)
      ORDER BY from_ledger DESC
      LIMIT 1`,
    [owner, ledger]
  );

  return rows[0] ? mapPortfolioAtLedger(rows[0]) : null;
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Uint8Array {
  const cleaned = input.toLowerCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new InvalidCidError('Invalid base32 character in CID');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function base58Decode(input: string): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of input) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) {
      throw new InvalidCidError('Invalid base58 character in CID');
    }
    value = value * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  let leadingZeros = 0;
  for (const char of input) {
    if (char === '1') leadingZeros++;
    else break;
  }
  return Uint8Array.from([...new Array(leadingZeros).fill(0), ...bytes]);
}

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let value = n;
  while (value >= 0x80) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value & 0x7f);
  return out;
}

function decodeVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < bytes.length) {
    const byte = bytes[i];
    value |= (byte & 0x7f) << shift;
    i++;
    if ((byte & 0x80) === 0) {
      return { value, next: i };
    }
    shift += 7;
    if (shift > 35) break;
  }
  throw new InvalidCidError('Malformed varint in CID');
}

const CIDV1_PREFIX = [0x01, 0x70, 0x12, 0x20];

/**
 * Validate and normalise a CID to CIDv1 base32 (lowercase, no multibase prefix).
 * Accepts CIDv0 (base58btc, Qm...) and CIDv1 (base32, b...).
 */
export function normaliseCid(cid: string): string {
  if (typeof cid !== 'string' || cid.length === 0) {
    throw new InvalidCidError('CID must be a non-empty string');
  }
  const trimmed = cid.trim();

  // CIDv0: base58btc-encoded multihash, starts with "Qm", 46 chars.
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(trimmed)) {
    const digest = base58Decode(trimmed);
    if (digest.length !== 34 || digest[0] !== 0x12 || digest[1] !== 0x20) {
      throw new InvalidCidError('Unsupported CIDv0 multihash');
    }
    const bytes = Uint8Array.from([...CIDV1_PREFIX, ...digest.slice(2)]);
    return base32Encode(bytes);
  }

  // CIDv1 base32: multibase prefix "b" followed by base32.
  if (/^b[a-z2-7]+$/.test(trimmed)) {
    const bytes = base32Decode(trimmed.slice(1));
    if (bytes.length < 4) {
      throw new InvalidCidError('CID too short');
    }
    const version = decodeVarint(bytes, 0);
    if (version.value !== 1) {
      throw new InvalidCidError('Unsupported CID version');
    }
    const codec = decodeVarint(bytes, version.next);
    if (codec.value !== 0x70) {
      throw new InvalidCidError('Unsupported CID codec');
    }
    const mh = decodeVarint(bytes, codec.next);
    if (mh.value !== 0x12) {
      throw new InvalidCidError('Unsupported multihash function');
    }
    const len = decodeVarint(bytes, mh.next);
    if (len.value !== 0x20) {
      throw new InvalidCidError('Unsupported multihash length');
    }
    const digest = bytes.slice(len.next);
    if (digest.length !== 32) {
      throw new InvalidCidError('Invalid multihash digest length');
    }
    const normalised = Uint8Array.from([...CIDV1_PREFIX, ...digest]);
    return base32Encode(normalised);
  }

  throw new InvalidCidError('Unsupported CID format');
}

export async function findByCid(
  cid: string,
  options: { includeHistorical?: boolean } = {}
): Promise<CidReference[]> {
  const normalised = normaliseCid(cid);
  const includeHistorical = options.includeHistorical === true;

  const currentQuery = pool.query<{
    owner: string;
    ipfs_cid: string;
    template_id: string;
    updated_at: Date;
  }>(
    `SELECT owner, ipfs_cid, template_id, updated_at
       FROM portfolios
      WHERE cid_normalized = $1
      ORDER BY owner ASC`,
    [normalised]
  );

  const historicalQuery = includeHistorical
    ? pool.query<{
        owner: string;
        ipfs_cid: string;
        template_id: string;
        version: number;
        at: Date;
      }>(
        `SELECT owner, ipfs_cid, template_id, version, at
           FROM portfolio_versions
          WHERE cid_normalized = $1
          ORDER BY owner ASC, version DESC`,
        [normalised]
      )
    : Promise.resolve({ rows: [] as Array<{
        owner: string;
        ipfs_cid: string;
        template_id: string;
        version: number;
        at: Date;
      }> });

  const [current, historical] = await Promise.all([currentQuery, historicalQuery]);

  const results: CidReference[] = current.rows.map((row) => ({
    owner: row.owner,
    ipfsCid: row.ipfs_cid,
    templateId: Number(row.template_id),
    version: null,
    historical: false,
    at: row.updated_at,
  }));

  if (includeHistorical) {
    for (const row of historical.rows) {
      results.push({
        owner: row.owner,
        ipfsCid: row.ipfs_cid,
        templateId: Number(row.template_id),
        version: Number(row.version),
        historical: true,
        at: row.at,
      });
    }
  }

  return results;
}