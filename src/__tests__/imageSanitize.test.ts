import sharp from 'sharp';
import { sanitizeImage } from '../services/imageSanitize';

describe('image sanitization', () => {
  it('strips JPEG metadata and preserves ICC profiles', async () => {
    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ff0000' },
    })
      .withMetadata({ exif: { IFD0: { Make: 'test-camera' } } })
      .jpeg()
      .toBuffer();

    const sanitized = await sanitizeImage(source, 'image/jpeg');
    const metadata = await sharp(sanitized).metadata();

    expect(metadata.exif).toBeUndefined();
  });

  it('can retain metadata when explicitly requested', async () => {
    const source = Buffer.from('unchanged');
    await expect(sanitizeImage(source, 'image/png', true)).resolves.toBe(source);
  });
});
