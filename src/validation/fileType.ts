/**
 * Detect the real type of an upload from its leading bytes. The client-supplied
 * mimetype is not trusted on its own.
 */
export function sniffContentType(buffer: Buffer): string | null {
  const startsWith = (bytes: number[], offset = 0) =>
    buffer.length >= offset + bytes.length && bytes.every((b, i) => buffer[offset + i] === b);

  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}

export interface ImageDimensionLimits {
  /** Maximum total pixels (width * height). */
  maxPixels: number;
  /** Maximum length of either side in pixels. */
  maxSide: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Read the declared dimensions of an image from its header without decoding
 * pixel data. Returns null when the dimensions cannot be determined (e.g. an
 * unsupported or malformed header).
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  const type = sniffContentType(buffer);
  switch (type) {
    case 'image/png':
      return readPngDimensions(buffer);
    case 'image/jpeg':
      return readJpegDimensions(buffer);
    case 'image/webp':
      return readWebpDimensions(buffer);
    default:
      return null;
  }
}

function readPngDimensions(buffer: Buffer): ImageDimensions | null {
  // PNG signature (8 bytes) followed by the IHDR chunk:
  // length (4) + "IHDR" (4) + width (4) + height (4) ...
  const IHDR_OFFSET = 8;
  if (buffer.length < IHDR_OFFSET + 16) return null;
  // Verify the first chunk is IHDR.
  if (
    buffer[IHDR_OFFSET + 4] !== 0x49 || // I
    buffer[IHDR_OFFSET + 5] !== 0x48 || // H
    buffer[IHDR_OFFSET + 6] !== 0x44 || // D
    buffer[IHDR_OFFSET + 7] !== 0x52 // R
  ) {
    return null;
  }
  const width = buffer.readUInt32BE(IHDR_OFFSET + 8);
  const height = buffer.readUInt32BE(IHDR_OFFSET + 12);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  // Walk the marker segments looking for a Start Of Frame (SOFn) marker.
  let offset = 2; // skip SOI (0xFFD8)
  while (offset + 4 <= buffer.length) {
    // Markers are 0xFF followed by a non-zero, non-0xFF marker byte.
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = buffer[offset + 1];
    // Skip fill bytes (0xFF padding).
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset++;
      marker = buffer[offset + 1];
    }
    offset += 2;

    // Standalone markers without a length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      continue;
    }
    // End of image or start of scan without finding a SOF.
    if (marker === 0xda || marker === 0xd9) return null;

    if (offset + 2 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2) return null;

    // SOF0..SOF15 except DHT (0xC4), JPG (0xC8), DAC (0xCC).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // Segment: length (2) + precision (1) + height (2) + width (2) ...
      if (offset + 7 > buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }

    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | null {
  // RIFF header: "RIFF" (4) + size (4) + "WEBP" (4), then a chunk.
  const CHUNK_OFFSET = 12;
  if (buffer.length < CHUNK_OFFSET + 8) return null;
  const fourCC = buffer.toString('ascii', CHUNK_OFFSET, CHUNK_OFFSET + 4);

  if (fourCC === 'VP8 ') {
    // Lossy: chunk header (8) + frame tag (3) + start code (3) + width (2) + height (2).
    const dataOffset = CHUNK_OFFSET + 8;
    if (buffer.length < dataOffset + 10) return null;
    // Start code must be 0x9D 0x01 0x2A.
    if (buffer[dataOffset + 3] !== 0x9d || buffer[dataOffset + 4] !== 0x01 || buffer[dataOffset + 5] !== 0x2a) {
      return null;
    }
    const width = buffer.readUInt16LE(dataOffset + 6) & 0x3fff;
    const height = buffer.readUInt16LE(dataOffset + 8) & 0x3fff;
    if (width === 0 || height === 0) return null;
    return { width, height };
  }

  if (fourCC === 'VP8L') {
    // Lossless: chunk header (8) + signature (1) + packed dimensions (4).
    const dataOffset = CHUNK_OFFSET + 8;
    if (buffer.length < dataOffset + 5) return null;
    if (buffer[dataOffset] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(dataOffset + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }

  if (fourCC === 'VP8X') {
    // Extended: chunk header (8) + flags (1) + reserved (3) + canvas width-1 (3) + canvas height-1 (3).
    const dataOffset = CHUNK_OFFSET + 8;
    if (buffer.length < dataOffset + 10) return null;
    const width = buffer.readUIntLE(dataOffset + 4, 3) + 1;
    const height = buffer.readUIntLE(dataOffset + 7, 3) + 1;
    return { width, height };
  }

  return null;
}

/**
 * Validate that an image's declared dimensions are within the configured
 * limits. Returns an error message when the limits are exceeded, or null when
 * the image is acceptable (or its dimensions cannot be determined).
 */
export function validateImageDimensions(
  buffer: Buffer,
  limits: ImageDimensionLimits,
): string | null {
  const dimensions = readImageDimensions(buffer);
  if (!dimensions) return null;

  const { width, height } = dimensions;
  if (width > limits.maxSide || height > limits.maxSide) {
    return 'Image dimensions exceed limit';
  }
  if (width * height > limits.maxPixels) {
    return 'Image dimensions exceed limit';
  }
  return null;
}

/**
 * Validate a PDF for active content. Delegates to the PDF validation module.
 * Returns an error message when the PDF is rejected, or null when acceptable.
 */
export function validatePdf(buffer: Buffer): string | null {
  return validatePdfContent(buffer);
}

import { validatePdfContent } from './pdf';