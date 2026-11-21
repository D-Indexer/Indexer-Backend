import { z } from 'zod';

/** Account (G...) or contract (C...) strkey: a contract Address can own a folder too. */
export const stellarAddressSchema = z.string().regex(/^[GC][A-Z2-7]{55}$/, 'Invalid Stellar address');

export const MAX_LOOKUP_ADDRESSES = 100;

/**
 * Body for the batch lookup endpoints: 1–100 addresses, de-duplicated. Invalid
 * entries are reported individually so clients can fix them in one round trip.
 */
export const addressLookupSchema = z.object({
  addresses: z
    .array(z.unknown(), { invalid_type_error: 'addresses must be an array' })
    .min(1, 'addresses must contain at least 1 address')
    .max(MAX_LOOKUP_ADDRESSES, `addresses must contain at most ${MAX_LOOKUP_ADDRESSES} addresses`)
    .superRefine((values, ctx) => {
      values.forEach((value, index) => {
        const parsed = stellarAddressSchema.safeParse(value);
        if (!parsed.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: parsed.error.errors[0].message,
          });
        }
      });
    })
    .transform((values) => Array.from(new Set(values as string[]))),
});

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

/**
 * Portfolio token ids are u32 on-chain. The contract has no separate token id:
 * a portfolio is keyed by its owner address, so the token id is the owner's
 * strkey (see docs/api.md#get-nfttokenidmetadata).
 */
export const tokenIdSchema = stellarAddressSchema;

export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 20;

/** `limit` query param: 1–100, defaults to 20. */
export const listLimitSchema = z
  .string()
  .regex(/^\d+$/, 'limit must be a positive integer')
  .transform(Number)
  .refine((n) => n >= 1, 'limit must be at least 1')
  .refine((n) => n <= MAX_LIST_LIMIT, `limit must be at most ${MAX_LIST_LIMIT}`)
  .default(String(DEFAULT_LIST_LIMIT));

/** Opaque cursor: base64url of `v1:<order>:<timestamp>:<owner>`. */
export const listCursorSchema = z.string().min(1, 'cursor must not be empty').max(512, 'cursor is too long');

export const folderListQuerySchema = z.object({
  order: z.enum(['claimed_at']).default('claimed_at'),
  limit: listLimitSchema,
  cursor: listCursorSchema.optional(),
});

export const portfolioListQuerySchema = z.object({
  order: z.enum(['minted_at', 'updated_at']).default('minted_at'),
  limit: listLimitSchema,
  cursor: listCursorSchema.optional(),
});

export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 20;

/** `limit` query param: 1–100, defaults to 20. */
export const listLimitSchema = z
  .string()
  .regex(/^\d+$/, 'limit must be a positive integer')
  .transform(Number)
  .refine((n) => n >= 1, 'limit must be at least 1')
  .refine((n) => n <= MAX_LIST_LIMIT, `limit must be at most ${MAX_LIST_LIMIT}`)
  .default(String(DEFAULT_LIST_LIMIT));

/** Opaque cursor: base64url of `v1:<order>:<timestamp>:<owner>`. */
export const listCursorSchema = z.string().min(1, 'cursor must not be empty').max(512, 'cursor is too long');

export const folderListQuerySchema = z.object({
  order: z.enum(['claimed_at']).default('claimed_at'),
  limit: listLimitSchema,
  cursor: listCursorSchema.optional(),
});

export const portfolioListQuerySchema = z.object({
  order: z.enum(['minted_at', 'updated_at']).default('minted_at'),
  limit: listLimitSchema,
  cursor: listCursorSchema.optional(),
});

export const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const uploadFileSchema = z.object({
  mimetype: z
    .string()
    .refine((t) => (ALLOWED_UPLOAD_TYPES as readonly string[]).includes(t), 'Unsupported file type'),
  size: z.number().max(MAX_UPLOAD_BYTES, 'File exceeds 10 MB limit'),
});
