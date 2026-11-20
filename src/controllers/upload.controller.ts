import { Request, Response } from 'express';
import { pinFile, pinBundle } from '../services/ipfs';
import { asyncHandler } from '../middleware/asyncHandler';
import { uploadFileSchema, bundleManifestSchema } from '../validation/schemas';
import { sniffContentType } from '../validation/fileType';
import { validateImageDimensions } from '../validation/imageDimensions';
import { validatePdf } from '../validation/pdf';
import { badRequest } from '../http/errors';

const IMAGE_MIMETYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

async function validateFileContent(
  buffer: Buffer,
  mimetype: string,
  originalname: string,
): Promise<void> {
  if (sniffContentType(buffer) !== mimetype) {
    throw badRequest('File content does not match its declared type');
  }

  if (IMAGE_MIMETYPES.has(mimetype)) {
    const imageResult = validateImageDimensions(buffer, mimetype);
    if (!imageResult.ok) {
      throw badRequest(imageResult.message);
    }
  }

  if (mimetype === 'application/pdf') {
    const pdfResult = await validatePdf(buffer);
    if (!pdfResult.ok) {
      throw badRequest(pdfResult.message);
    }
  }
}

export const upload = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw badRequest('No file provided');

  const result = uploadFileSchema.safeParse({ mimetype: file.mimetype, size: file.size });
  if (!result.success) throw badRequest(result.error.errors[0].message);

  await validateFileContent(file.buffer, file.mimetype, file.originalname);

  const cid = await pinFile(file.buffer, file.originalname);
  res.json({ cid });
});

export const uploadBundle = asyncHandler(async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw badRequest('No files provided');

  const manifestFile = files.find((f) => f.fieldname === 'manifest');
  if (!manifestFile) throw badRequest('No manifest provided');

  const assetFiles = files.filter((f) => f.fieldname !== 'manifest');
  if (assetFiles.length === 0) throw badRequest('No asset files provided');

  // Validate the manifest JSON against the schema.
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestFile.buffer.toString('utf8'));
  } catch {
    throw badRequest('Manifest is not valid JSON');
  }

  const manifestResult = bundleManifestSchema.safeParse(manifestJson);
  if (!manifestResult.success) {
    throw badRequest(manifestResult.error.errors[0].message);
  }

  // Validate every asset file with the existing type/size/sniffing rules plus
  // image/PDF checks. Any failure rejects the whole bundle before pinning.
  const seenPaths = new Set<string>();
  for (const file of assetFiles) {
    const result = uploadFileSchema.safeParse({ mimetype: file.mimetype, size: file.size });
    if (!result.success) throw badRequest(result.error.errors[0].message);

    await validateFileContent(file.buffer, file.mimetype, file.originalname);

    const path = file.originalname;
    if (seenPaths.has(path)) {
      throw badRequest(`Duplicate file path in bundle: ${path}`);
    }
    seenPaths.add(path);
  }

  const bundleFiles = [
    { path: 'manifest.json', buffer: manifestFile.buffer },
    ...assetFiles.map((f) => ({ path: f.originalname, buffer: f.buffer })),
  ];

  const { rootCid, files: fileCids } = await pinBundle(bundleFiles);
  res.json({ rootCid, files: fileCids });
});