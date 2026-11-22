import { z } from 'zod';
import { StrKey, MuxedAccount } from '@stellar/stellar-sdk';

/**
 * Validates a Stellar address using the SDK's checksum-verified strkey decoder.
 * Accepts G... (Ed25519 public keys) and C... (contract addresses).
 * Also accepts M... (muxed accounts) and resolves them to their base G... account.
 * Returns the canonical G.../C... address.
 */
export const stellarAddressSchema = z.string().transform((val, ctx) => {
  // Muxed account: resolve to base G... address
  if (val.startsWith('M')) {
    try {
      const muxed = MuxedAccount.fromAddress(val, '0');
      return muxed.baseAccount().accountId();
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Stellar address checksum' });
      return z.NEVER;
    }
  }
  if (StrKey.isValidEd25519PublicKey(val) || StrKey.isValidContract(val)) {
    return val;
  }
  // Distinguish bad checksum from bad format
  if (/^[GC][A-Z2-7]{55}$/.test(val)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Stellar address checksum' });
  } else {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Stellar address' });
  }
  return z.NEVER;
});

/**
 * Folder name rules derived from the Indexer-Contract naming constraints:
 * - 1–64 characters
 * - Lowercase letters, digits, hyphens and underscores only (contract compares case-insensitively; we normalise to lower)
 * - Must not start or end with a hyphen or underscore
 * - Reserved names: "admin", "contract", "system"
 */
export const FOLDER_NAME_MAX_LENGTH = 64;
export const FOLDER_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/;
export const FOLDER_NAME_RESERVED = new Set(['admin', 'contract', 'system']);

export const folderNameSchema = z
  .string()
  .trim()
  .min(1, 'Folder name is required')
  .max(FOLDER_NAME_MAX_LENGTH, `Folder name must be at most ${FOLDER_NAME_MAX_LENGTH} characters`)
  .transform((v) => v.toLowerCase())
  .refine((v) => FOLDER_NAME_REGEX.test(v), 'Folder name contains unsupported characters')
  .refine((v) => !FOLDER_NAME_RESERVED.has(v), 'Folder name is reserved');

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
