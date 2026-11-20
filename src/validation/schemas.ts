import { z } from 'zod';

/** Account (G...) or contract (C...) strkey: a contract Address can own a folder too. */
export const stellarAddressSchema = z.string().regex(/^[GC][A-Z2-7]{55}$/, 'Invalid Stellar address');

export const folderNameSchema = z
  .string()
  .trim()
  .min(1, 'Folder name is required')
  .max(64, 'Folder name must be at most 64 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Folder name contains unsupported characters');

/** Template ids are u32 on-chain. */
export const templateIdSchema = z
  .string()
  .regex(/^\d+$/, 'Template ID must be a number')
  .transform(Number)
  .refine((n) => n <= 0xffffffff, 'Template ID must be at most 4294967295');

export const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const uploadFileSchema = z.object({
  mimetype: z
    .string()
    .refine((t) => (ALLOWED_UPLOAD_TYPES as readonly string[]).includes(t), 'Unsupported file type'),
  size: z.number().max(MAX_UPLOAD_BYTES, 'File exceeds 10 MB limit'),
});

/**
 * `?atLedger=` query parameter: a non-negative integer ledger sequence.
 * Accepts a string (as it arrives from the query string) or a number.
 */
export const atLedgerQuerySchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v : v.trim()))
  .refine((v) => typeof v === 'number' || /^\d+$/.test(v), 'atLedger must be a non-negative integer')
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .refine((n) => Number.isSafeInteger(n) && n >= 0, 'atLedger must be a non-negative integer');

// ---------------------------------------------------------------------------
// CID validation / normalisation (CIDv0 + CIDv1)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const BASE58_MAP: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) BASE58_MAP[BASE58_ALPHABET[i]] = i;

const BASE32_MAP: Record<string, number> = {};
for (let i = 0; i < BASE32_ALPHABET.length; i++) BASE32_MAP[BASE32_ALPHABET[i]] = i;

function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  let zeros = 0;
  while (zeros < input.length && input[zeros] === '1') zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < input.length; i++) {
    const val = BASE58_MAP[input[i]];
    if (val === undefined) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

function base32Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input) {
    const val = BASE32_MAP[ch];
    if (val === undefined) return null;
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

const CIDV0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CIDV1_REGEX = /^b[a-z2-7]+$/;

interface ParsedCid {
  version: 0 | 1;
  /** Multihash bytes (code + length + digest). */
  multihash: Uint8Array;
  /** Canonical CIDv1 base32 string. */
  canonical: string;
  /** Hex of the multihash digest, used as the normalised lookup key. */
  digestHex: string;
}

function parseCid(input: string): ParsedCid | null {
  const cid = input.trim();
  if (cid.length === 0) return null;

  // CIDv0: base58btc-encoded sha2-256 multihash, always starts with "Qm".
  if (CIDV0_REGEX.test(cid)) {
    const multihash = base58Decode(cid);
    if (!multihash || multihash.length !== 34) return null;
    if (multihash[0] !== 0x12 || multihash[1] !== 0x20) return null;
    const digest = multihash.subarray(2);
    const v1Bytes = new Uint8Array(2 + multihash.length);
    v1Bytes[0] = 0x01; // CIDv1
    v1Bytes[1] = 0x70; // dag-pb
    v1Bytes.set(multihash, 2);
    return {
      version: 0,
      multihash,
      canonical: 'b' + base32Encode(v1Bytes),
      digestHex: bytesToHex(digest),
    };
  }

  // CIDv1: multibase base32 (lowercase, prefix "b").
  if (CIDV1_REGEX.test(cid)) {
    const bytes = base32Decode(cid.slice(1));
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] !== 0x01) return null; // must be CIDv1
    // Skip the codec varint.
    let idx = 1;
    while (idx < bytes.length && (bytes[idx] & 0x80) !== 0) idx++;
    idx++;
    if (idx >= bytes.length) return null;
    const multihash = bytes.subarray(idx);
    if (multihash.length < 2) return null;
    // Multihash code varint (we only support sha2-256 = 0x12).
    if (multihash[0] !== 0x12 || multihash[1] !== 0x20) return null;
    if (multihash.length !== 34) return null;
    const digest = multihash.subarray(2);
    return {
      version: 1,
      multihash,
      canonical: 'b' + base32Encode(bytes),
      digestHex: bytesToHex(digest),
    };
  }

  return null;
}

/**
 * CID schema: validates a CIDv0 or CIDv1 string and normalises it.
 * The parsed value exposes the canonical CIDv1 form and a digest-based key
 * so lookups match across CIDv0/CIDv1 representations of the same content.
 */
export const cidSchema = z
  .string()
  .trim()
  .min(1, 'CID is required')
  .max(128, 'CID is too long')
  .superRefine((value, ctx) => {
    if (!parseCid(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid CID (expected CIDv0 or CIDv1)',
      });
    }
  })
  .transform((value) => {
    const parsed = parseCid(value)!;
    return {
      input: value,
      version: parsed.version,
      canonical: parsed.canonical,
      digestHex: parsed.digestHex,
    };
  });

export type ParsedCid = z.infer<typeof cidSchema>;

/** Normalise a CID to its canonical CIDv1 base32 form, or null if invalid. */
export function normaliseCid(value: string): string | null {
  const parsed = parseCid(value);
  return parsed ? parsed.canonical : null;
}

/** Normalised lookup key (hex digest) for a CID, or null if invalid. */
export function cidLookupKey(value: string): string | null {
  const parsed = parseCid(value);
  return parsed ? parsed.digestHex : null;
}

// ---------------------------------------------------------------------------
// Keyset pagination (limit + cursor)
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/**
 * Keyset pagination for version endpoints.
 * `cursor` is an opaque, URL-safe token (base64url of the last seen key).
 */
export const keysetPaginationSchema = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return DEFAULT_PAGE_LIMIT;
      return typeof v === 'number' ? v : Number(v.trim());
    })
    .refine((n) => Number.isInteger(n) && n >= 1, 'limit must be a positive integer')
    .refine((n) => n <= MAX_PAGE_LIMIT, `limit must be at most ${MAX_PAGE_LIMIT}`),
  cursor: z
    .string()
    .trim()
    .max(512, 'cursor is too long')
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v))
    .refine(
      (v) => v === undefined || /^[A-Za-z0-9_-]+$/.test(v),
      'cursor must be a valid pagination token',
    ),
});

export type KeysetPagination = z.infer<typeof keysetPaginationSchema>;

/** Encode a keyset cursor from its component parts. */
export function encodeCursor(parts: Array<string | number>): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/** Decode a keyset cursor; returns null when malformed. */
export function decodeCursor(cursor: string): Array<string | number> | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((p) => typeof p === 'string' || typeof p === 'number')) return null;
    return parsed;
  } catch {
    return null;
  }
}