import { z } from 'zod';

export const stellarAddressSchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar address');

export const folderNameSchema = z
  .string()
  .trim()
  .min(1, 'Folder name is required')
  .max(64, 'Folder name must be at most 64 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Folder name contains unsupported characters');

export const templateIdSchema = z
  .string()
  .regex(/^\d+$/, 'Template ID must be a number');

export const uploadFileSchema = z.object({
  mimetype: z.string().refine(
    (t) => ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(t),
    'Unsupported file type'
  ),
  size: z.number().max(10 * 1024 * 1024, 'File exceeds 10 MB limit'),
});
