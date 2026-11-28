import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFObject } from 'pdf-lib';

export type PdfValidationResult = { ok: true } | { ok: false; message: string };

const PDF_PARSE_TIMEOUT_MS = 5000;

const ACTIVE_CONTENT_KEYS = ['JS', 'JavaScript', 'Launch', 'EmbeddedFile', 'RichMedia', 'OpenAction', 'AA'];

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isEncrypted(doc: PDFDocument): boolean {
  try {
    const trailer = doc.context.trailerInfo;
    if (trailer && trailer.Encrypt) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function collectActiveContent(
  obj: PDFObject | undefined,
  visited: Set<PDFObject>,
  found: Set<string>,
): void {
  if (!obj || visited.has(obj)) {
    return;
  }
  visited.add(obj);

  if (obj instanceof PDFDict) {
    for (const [key, value] of obj.entries()) {
      const keyName = key.asString().replace(/^\//, '');
      if (ACTIVE_CONTENT_KEYS.includes(keyName)) {
        found.add(keyName);
      }
      collectActiveContent(value, visited, found);
    }
  } else if (obj instanceof PDFArray) {
    for (const item of obj.asArray()) {
      collectActiveContent(item, visited, found);
    }
  } else if (obj instanceof PDFRawStream) {
    collectActiveContent(obj.dict, visited, found);
  }
}

function describeReason(key: string): string {
  switch (key) {
    case 'JS':
    case 'JavaScript':
      return 'PDF contains JavaScript';
    case 'Launch':
      return 'PDF contains a Launch action';
    case 'EmbeddedFile':
      return 'PDF contains embedded files';
    case 'RichMedia':
      return 'PDF contains RichMedia content';
    case 'OpenAction':
      return 'PDF contains an OpenAction';
    case 'AA':
      return 'PDF contains additional actions (AA)';
    default:
      return `PDF contains active content (${key})`;
  }
}

export async function validatePdf(buffer: Buffer): Promise<PdfValidationResult> {
  if (!buffer || buffer.length === 0) {
    return { ok: false, message: 'PDF file is empty' };
  }

  let doc: PDFDocument;
  try {
    doc = await withTimeout(
      PDFDocument.load(buffer, { ignoreEncryption: false, updateMetadata: false }),
      PDF_PARSE_TIMEOUT_MS,
      'PDF parsing timed out',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/encrypt/i.test(msg)) {
      return { ok: false, message: 'Encrypted PDFs are not allowed' };
    }
    if (/timed out/i.test(msg)) {
      return { ok: false, message: 'PDF parsing timed out' };
    }
    return { ok: false, message: 'PDF could not be parsed' };
  }

  if (isEncrypted(doc)) {
    return { ok: false, message: 'Encrypted PDFs are not allowed' };
  }

  const found = new Set<string>();
  const visited = new Set<PDFObject>();
  try {
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      collectActiveContent(obj, visited, found);
    }
  } catch {
    return { ok: false, message: 'PDF could not be parsed' };
  }

  if (found.size > 0) {
    // Prefer the most specific reason.
    const priority = ['JavaScript', 'JS', 'Launch', 'EmbeddedFile', 'RichMedia', 'OpenAction', 'AA'];
    for (const key of priority) {
      if (found.has(key)) {
        return { ok: false, message: describeReason(key) };
      }
    }
    const first = found.values().next().value as string;
    return { ok: false, message: describeReason(first) };
  }

  return { ok: true };
}