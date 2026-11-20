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

/** Parse a positive integer from env, falling back to a default. */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Maximum number of files (including manifest.json) allowed in a bundle. */
export const MAX_BUNDLE_FILES = positiveIntFromEnv('MAX_BUNDLE_FILES', 20);

/** Maximum total size in bytes of all files in a bundle. */
export const MAX_BUNDLE_BYTES = positiveIntFromEnv('MAX_BUNDLE_BYTES', 50 * 1024 * 1024);

/** Stable path for the bundle manifest inside the wrapped directory. */
export const BUNDLE_MANIFEST_PATH = 'manifest.json';

/** A CIDv0 or CIDv1 string (base32/base58btc). */
export const cidSchema = z
  .string()
  .trim()
  .min(1, 'CID is required')
  .regex(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/, 'Invalid CID');

/** Relative path inside the bundle: no leading slash, no traversal, no empty segments. */
export const bundlePathSchema = z
  .string()
  .trim()
  .min(1, 'Path is required')
  .max(256, 'Path must be at most 256 characters')
  .refine((p) => !p.startsWith('/'), 'Path must be relative')
  .refine((p) => !p.includes('\\'), 'Path must use forward slashes')
  .refine(
    (p) => p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
    'Path contains invalid segments',
  );

export const bundleManifestFileSchema = z.object({
  path: bundlePathSchema,
  cid: cidSchema,
});

export const bundleManifestSchema = z
  .object({
    name: z.string().trim().min(1, 'Manifest name is required').max(128, 'Manifest name must be at most 128 characters'),
    version: z
      .string()
      .trim()
      .regex(/^\d+\.\d+\.\d+$/, 'Manifest version must be semver (e.g. 1.0.0)'),
    files: z.array(bundleManifestFileSchema).min(1, 'Manifest must reference at least one file'),
  })
  .strict()
  .refine(
    (m) => new Set(m.files.map((f) => f.path)).size === m.files.length,
    'Manifest contains duplicate file paths',
  )
  .refine(
    (m) => !m.files.some((f) => f.path === BUNDLE_MANIFEST_PATH),
    'Manifest must not reference itself',
  );

export type BundleManifest = z.infer<typeof bundleManifestSchema>;