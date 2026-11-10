import { z } from 'zod';

/** Account (G...) or contract (C...) strkey: a contract Address can own a folder too. */
export const stellarAddressSchema = z
  .string()
  .regex(/^[GC][A-Z2-7]{55}$/, 'Invalid Stellar address');

export const folderNameSchema = z
  .string()
  .trim()
  .min(1, 'Folder name is required')
  .max(64, 'Folder name must be at most 64 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Folder name contains unsupported characters');

/** Template ids are u32 on-chain. */
export const templateIdSchema = z
  .string()
  .regex(/^\d{1,10}$/, 'Template ID must be a number')
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
