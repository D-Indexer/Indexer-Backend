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

/** Contract event topics the indexer decodes (see src/indexer/decode.ts). */
export const EVENT_TOPICS = [
  'init',
  'adm_add',
  'adm_rm',
  'folder_cl',
  'tmpl_reg',
  'tmpl_set',
  'port_mint',
  'port_upd',
] as const;

export const EVENT_STATUSES = ['applied', 'ignored', 'rejected'] as const;

const ledgerSchema = z
  .string()
  .regex(/^\d+$/, 'Ledger must be a number')
  .transform(Number)
  .refine((n) => n <= 0xffffffff, 'Ledger must be at most 4294967295');

/** `cursor` is the opaque `nextCursor` from a previous page: `<ledger>:<id>`. */
export const eventCursorSchema = z
  .string()
  .regex(/^\d+:[^:]+$/, 'Invalid cursor')
  .transform((value) => {
    const [ledger, id] = value.split(':');
    return { ledger: Number(ledger), id };
  });

export const eventListQuerySchema = z.object({
  topic: z.enum(EVENT_TOPICS, { message: 'Unsupported topic' }).optional(),
  owner: stellarAddressSchema.optional(),
  status: z.enum(EVENT_STATUSES, { message: 'Unsupported status' }).optional(),
  fromLedger: ledgerSchema.optional(),
  toLedger: ledgerSchema.optional(),
  limit: z
    .string()
    .regex(/^\d+$/, 'Limit must be a number')
    .transform(Number)
    .refine((n) => n >= 1 && n <= 100, 'Limit must be between 1 and 100')
    .optional(),
  cursor: eventCursorSchema.optional(),
});

export const eventIdSchema = z.string().trim().min(1, 'Event ID is required').max(128, 'Event ID is too long');

export const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const uploadFileSchema = z.object({
  mimetype: z
    .string()
    .refine((t) => (ALLOWED_UPLOAD_TYPES as readonly string[]).includes(t), 'Unsupported file type'),
  size: z.number().max(MAX_UPLOAD_BYTES, 'File exceeds 10 MB limit'),
});
