import sharp from 'sharp';

export async function sanitizeImage(
  buffer: Buffer,
  mime: 'image/jpeg' | 'image/png' | 'image/webp',
  keepMetadata = false
): Promise<Buffer> {
  if (keepMetadata) return buffer;

  const image = sharp(buffer, { failOn: 'none' }).keepIccProfile();
  switch (mime) {
    case 'image/jpeg':
      return image.jpeg().toBuffer();
    case 'image/png':
      return image.png().toBuffer();
    case 'image/webp':
      return image.webp().toBuffer();
  }
}
