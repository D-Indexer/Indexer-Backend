import { createHash } from 'crypto';
import { once } from 'events';
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, open, rename, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { createGunzip, createGzip } from 'zlib';
import type { Pool, PoolClient } from 'pg';
import { logger as defaultLogger } from '../utils/logger';
import { ensurePartitions } from './partitions';
import type { GetEventsResult, RawEvent } from './rpc';
import { ledgerFromCursor, readState, STATE, writeState } from './state';
import { rowToRawEvent } from './xdrStorage';

/**
 * Indexer snapshots: a portable, verifiable copy of `contract_events` (raw XDR
 * + metadata) and the cursor, so a new environment (staging, a community
 * mirror, disaster recovery) can start with full history instead of only what
 * the RPC still retains (~7 days).
 *
 * File layout: an uncompressed POSIX ustar archive with exactly two entries,
 *
 *   manifest.json      SnapshotManifest (below)
 *   events.ndjson.gz   gzip'd NDJSON, one RawEvent (base64 XDR, exactly as the
 *                      RPC returned it) per line, ordered by (ledger, id)
 *
 * The manifest pins the network passphrase and contract id, and carries the
 * sha256 of events.ndjson.gz. Import verifies both before writing anything,
 * then re-applies the events through the indexer's normal page path, which
 * inserts idempotently and rebuilds the read model, and finally sets the
 * cursor. Import is resumable: progress is checkpointed in indexer_state after
 * every chunk.
 *
 * See docs/operations.md#bootstrapping-from-a-snapshot.
 */

export const SNAPSHOT_FORMAT = 'folder-indexer-snapshot';
/** Bump on incompatible changes to the archive layout or manifest. */
export const SNAPSHOT_FORMAT_VERSION = 1;
/** Bump on incompatible changes to the event record (one NDJSON line). */
export const SNAPSHOT_SCHEMA_VERSION = 1;

const MANIFEST_FILE = 'manifest.json';
const EVENTS_FILE = 'events.ndjson.gz';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const EXPORT_PAGE = 5000;

/** indexer_state keys owned by snapshot import. */
export const SNAPSHOT_STATE = {
  /** In-progress import checkpoint (JSON); removed when the import completes. */
  progress: 'snapshot_import',
  /** Last completed import (JSON), for operators. */
  imported: 'snapshot_imported',
  /** Network/contract this database holds events for; imports must match. */
  networkPassphrase: 'network_passphrase',
  contractId: 'contract_id',
} as const;

export type SnapshotManifest = {
  format: typeof SNAPSHOT_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  createdAt: string;
  networkPassphrase: string;
  contractId: string;
  /** Ledgers of the first and last exported event; null when there are none. */
  ledgerRange: { from: number; to: number } | null;
  eventCount: number;
  /** indexer_state cursor / last_ledger at export time (same snapshot as the events). */
  cursor: string | null;
  lastLedger: number | null;
  files: { [EVENTS_FILE]: { sha256: string; bytes: number } };
};

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

type Logger = Pick<typeof defaultLogger, 'info' | 'warn'>;

/** Snapshots are tied to one network and one contract. */
export type SnapshotTarget = { networkPassphrase: string; contractId: string };

// ---------------------------------------------------------------------------
// Minimal ustar archive (no dependency; two regular files, no long names)
// ---------------------------------------------------------------------------

const BLOCK = 512;

function tarHeader(name: string, size: number, mtime: Date): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name too long: ${name}`);
  const header = Buffer.alloc(BLOCK, 0);
  const put = (value: string, offset: number, length: number) => header.write(value, offset, length, 'ascii');
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder: 8 spaces
  put('0', 156, 1); // regular file
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

function parseTarHeader(header: Buffer): { name: string; size: number } | null {
  if (header.every((b) => b === 0)) return null;
  const field = (offset: number, length: number) =>
    header
      .toString('ascii', offset, offset + length)
      .replace(/\0.*$/s, '')
      .trim();
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header.readUInt8(i);
  if (parseInt(field(148, 8), 8) !== sum)
    throw new SnapshotError('snapshot archive is corrupt (tar header checksum)');
  if (field(257, 6) !== 'ustar') throw new SnapshotError('snapshot archive is not a ustar archive');
  const size = parseInt(field(124, 12), 8);
  if (!Number.isSafeInteger(size) || size < 0)
    throw new SnapshotError('snapshot archive is corrupt (entry size)');
  return { name: field(0, 100), size };
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

async function writeTar(
  dest: string,
  entries: Array<{ name: string; data: Buffer } | { name: string; file: string }>
): Promise<void> {
  const out = await open(dest, 'w');
  try {
    const now = new Date();
    for (const entry of entries) {
      const size = 'data' in entry ? entry.data.length : (await stat(entry.file)).size;
      await out.write(tarHeader(entry.name, size, now));
      if ('data' in entry) {
        await out.write(entry.data);
      } else {
        for await (const chunk of createReadStream(entry.file)) await out.write(chunk as Buffer);
      }
      await out.write(Buffer.alloc(padding(size)));
    }
    await out.write(Buffer.alloc(BLOCK * 2));
    await out.sync();
  } finally {
    await out.close();
  }
}

/**
 * Read the archive: the manifest into memory, the events entry to `eventsDest`
 * (hashing it on the way). Unknown, duplicate or missing entries are errors.
 */
async function readTar(
  source: string,
  eventsDest: string
): Promise<{ manifest: Buffer; eventsSha256: string; eventsBytes: number }> {
  const input = await open(source, 'r');
  try {
    let offset = 0;
    let manifest: Buffer | undefined;
    let events: { sha256: string; bytes: number } | undefined;
    const header = Buffer.alloc(BLOCK);
    for (;;) {
      const { bytesRead } = await input.read(header, 0, BLOCK, offset);
      if (bytesRead < BLOCK) throw new SnapshotError('snapshot archive is truncated');
      offset += BLOCK;
      const entry = parseTarHeader(header);
      if (!entry) break;

      if (entry.name === MANIFEST_FILE && !manifest) {
        if (entry.size > MAX_MANIFEST_BYTES) throw new SnapshotError('snapshot manifest is too large');
        manifest = Buffer.alloc(entry.size);
        const read = await input.read(manifest, 0, entry.size, offset);
        if (read.bytesRead < entry.size) throw new SnapshotError('snapshot archive is truncated');
      } else if (entry.name === EVENTS_FILE && !events) {
        const hash = createHash('sha256');
        const out = await open(eventsDest, 'w');
        try {
          const chunk = Buffer.alloc(1024 * 1024);
          for (let done = 0; done < entry.size;) {
            const want = Math.min(chunk.length, entry.size - done);
            const read = await input.read(chunk, 0, want, offset + done);
            if (read.bytesRead === 0) throw new SnapshotError('snapshot archive is truncated');
            const piece = chunk.subarray(0, read.bytesRead);
            hash.update(piece);
            await out.write(piece);
            done += read.bytesRead;
          }
        } finally {
          await out.close();
        }
        events = { sha256: hash.digest('hex'), bytes: entry.size };
      } else {
        throw new SnapshotError(`unexpected entry in snapshot archive: ${entry.name}`);
      }
      offset += entry.size + padding(entry.size);
    }
    if (!manifest) throw new SnapshotError(`snapshot archive has no ${MANIFEST_FILE}`);
    if (!events) throw new SnapshotError(`snapshot archive has no ${EVENTS_FILE}`);
    return { manifest, eventsSha256: events.sha256, eventsBytes: events.bytes };
  } finally {
    await input.close();
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportOptions = SnapshotTarget & { logger?: Logger };

/**
 * Write a snapshot of every stored event for `contractId`, plus the cursor, to
 * `dest`. Reads in one REPEATABLE READ transaction so the events and the cursor
 * are mutually consistent even while the indexer keeps running. Use a direct
 * connection: the transaction stays open for the whole export.
 */
export async function exportSnapshot(
  db: Pick<Pool, 'connect'>,
  dest: string,
  options: ExportOptions
): Promise<SnapshotManifest> {
  const logger = options.logger ?? defaultLogger;
  const workDir = await mkdtemp(path.join(tmpdir(), 'folder-snapshot-'));
  const eventsPath = path.join(workDir, EVENTS_FILE);
  const client = await db.connect();
  const gzip = createGzip();
  const written = pipeline(gzip, createWriteStream(eventsPath));
  // Awaited below; this only keeps an early failure from being unhandled.
  written.catch(() => undefined);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const state = await readState(client);

    let eventCount = 0;
    let first: RawEvent | undefined;
    let last: RawEvent | undefined;
    let after = { ledger: -1, id: '' };
    for (;;) {
      const { rows } = await client.query(
        `SELECT id, ledger, ledger_closed_at, tx_hash, contract_id, topic_xdr, value_xdr
           FROM contract_events
          WHERE contract_id = $1 AND (ledger, id) > ($2, $3)
          ORDER BY ledger, id
          LIMIT $4`,
        [options.contractId, after.ledger, after.id, EXPORT_PAGE]
      );
      for (const row of rows) {
        const event = rowToRawEvent(row);
        if (!gzip.write(`${JSON.stringify(event)}\n`)) await once(gzip, 'drain');
        first ??= event;
        last = event;
        eventCount++;
      }
      if (rows.length < EXPORT_PAGE || !last) break;
      after = { ledger: last.ledger, id: last.id };
    }
    await client.query('COMMIT');
    gzip.end();
    await written;

    const hash = createHash('sha256');
    for await (const chunk of createReadStream(eventsPath)) hash.update(chunk as Buffer);
    const lastLedger = Number(state[STATE.lastLedger]);
    const manifest: SnapshotManifest = {
      format: SNAPSHOT_FORMAT,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      networkPassphrase: options.networkPassphrase,
      contractId: options.contractId,
      ledgerRange: first && last ? { from: first.ledger, to: last.ledger } : null,
      eventCount,
      cursor: state[STATE.cursor] ?? null,
      lastLedger: Number.isFinite(lastLedger) && lastLedger > 0 ? lastLedger : null,
      files: { [EVENTS_FILE]: { sha256: hash.digest('hex'), bytes: (await stat(eventsPath)).size } },
    };

    // Write next to the destination and rename, so a crash never leaves a
    // half-written archive under the final name.
    const partial = `${dest}.partial`;
    await writeTar(partial, [
      { name: MANIFEST_FILE, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      { name: EVENTS_FILE, file: eventsPath },
    ]);
    await rename(partial, dest);
    logger.info('Exported snapshot', {
      dest,
      events: eventCount,
      ledgerRange: manifest.ledgerRange,
      sha256: manifest.files[EVENTS_FILE].sha256,
    });
    return manifest;
  } catch (err) {
    gzip.destroy();
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await rm(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Persists one page of events and rebuilds the read model; `processPage` by default. */
export type ApplyPage = (
  db: Pick<Pool, 'connect' | 'query'>,
  contractId: string,
  page: GetEventsResult
) => Promise<unknown>;

export type ImportOptions = SnapshotTarget & {
  /** Events per page handed to `applyPage` (and per checkpoint). Default 500. */
  chunkSize?: number;
  applyPage?: ApplyPage;
  logger?: Logger;
};

export type ImportResult = {
  manifest: SnapshotManifest;
  /** Events handed to applyPage in this run. */
  applied: number;
  /** Events skipped because an interrupted run had already imported them. */
  skipped: number;
  resumed: boolean;
  cursor: string | null;
};

type Progress = {
  sha256: string;
  lastEventId: string | null;
  priorCursor: string | null;
  priorLastLedger: string | null;
};

function defaultApplyPage(): ApplyPage {
  // Loaded lazily: the indexer page path pulls in the event decoder.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { processPage } = require('./stellar') as typeof import('./stellar');
  return processPage;
}

function parseManifest(raw: Buffer): SnapshotManifest {
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(raw.toString('utf8')) as SnapshotManifest;
  } catch {
    throw new SnapshotError('snapshot manifest is not valid JSON');
  }
  if (manifest?.format !== SNAPSHOT_FORMAT) throw new SnapshotError('not a folder-indexer snapshot');
  if (manifest.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new SnapshotError(
      `unsupported snapshot format version ${manifest.formatVersion} (this build reads ${SNAPSHOT_FORMAT_VERSION})`
    );
  }
  if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotError(
      `unsupported snapshot schema version ${manifest.schemaVersion} (this build reads ${SNAPSHOT_SCHEMA_VERSION})`
    );
  }
  const file = manifest.files?.[EVENTS_FILE];
  if (!file || !/^[0-9a-f]{64}$/.test(file.sha256))
    throw new SnapshotError('snapshot manifest has no events checksum');
  return manifest;
}

/** Split an event id ("<toid>-<index>") for numeric ordering. */
function eventKey(id: string): [bigint, bigint] {
  const [toid, index] = id.split('-');
  return [BigInt(toid ?? '0'), BigInt(index ?? '0')];
}

export function compareEventIds(a: string, b: string): number {
  const [ta, ia] = eventKey(a);
  const [tb, ib] = eventKey(b);
  return ta === tb ? (ia === ib ? 0 : ia < ib ? -1 : 1) : ta < tb ? -1 : 1;
}

function validEvent(value: unknown, contractId: string): value is RawEvent {
  const e = value as Partial<RawEvent> | null;
  return (
    !!e &&
    typeof e.id === 'string' &&
    Number.isInteger(e.ledger) &&
    typeof e.ledgerClosedAt === 'string' &&
    typeof e.txHash === 'string' &&
    e.contractId === contractId &&
    Array.isArray(e.topic) &&
    e.topic.every((t) => typeof t === 'string') &&
    typeof e.value === 'string'
  );
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new SnapshotError(`failed to download snapshot: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(dest));
}

/** The cursor that is furthest along; a snapshot never rewinds a database that is ahead of it. */
function furthestCursor(...cursors: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const cursor of cursors) {
    if (!cursor) continue;
    if (best === null) {
      best = cursor;
      continue;
    }
    try {
      if (compareEventIds(cursor, best) > 0) best = cursor;
    } catch {
      if (ledgerFromCursor(cursor) > ledgerFromCursor(best)) best = cursor;
    }
  }
  return best;
}

/** Refuse a snapshot for another network/contract, or a database that holds another's events. */
async function assertCompatible(
  db: Pick<Pool, 'query'>,
  manifest: SnapshotManifest,
  target: SnapshotTarget,
  state: Partial<Record<string, string>>
): Promise<void> {
  if (manifest.networkPassphrase !== target.networkPassphrase) {
    throw new SnapshotError(
      `snapshot is for network "${manifest.networkPassphrase}" but this indexer is configured for ` +
        `"${target.networkPassphrase}"`
    );
  }
  if (manifest.contractId !== target.contractId) {
    throw new SnapshotError(
      `snapshot is for contract ${manifest.contractId} but this indexer is configured for ${target.contractId}`
    );
  }
  const storedNetwork = state[SNAPSHOT_STATE.networkPassphrase];
  if (storedNetwork && storedNetwork !== manifest.networkPassphrase) {
    throw new SnapshotError(
      `database holds events for network "${storedNetwork}", snapshot is for "${manifest.networkPassphrase}"`
    );
  }
  const storedContract = state[SNAPSHOT_STATE.contractId];
  if (storedContract && storedContract !== manifest.contractId) {
    throw new SnapshotError(
      `database holds events for contract ${storedContract}, snapshot is for ${manifest.contractId}`
    );
  }
  const { rows } = await db.query<{ contract_id: string }>(
    'SELECT contract_id FROM contract_events WHERE contract_id <> $1 LIMIT 1',
    [manifest.contractId]
  );
  if (rows[0]) {
    throw new SnapshotError(
      `database holds events for contract ${rows[0].contract_id}, snapshot is for ${manifest.contractId}`
    );
  }
}

/**
 * Import a snapshot from a local path or an http(s) URL.
 *
 * 1. Verifies the archive, the manifest (format/schema version) and the
 *    sha256 of the events before writing anything.
 * 2. Refuses a snapshot for a different network or contract than configured,
 *    or a database that already holds another network's/contract's events.
 * 3. Re-applies the events in ledger order through `applyPage` (the indexer's
 *    `processPage`): inserts are idempotent and the read model is rebuilt.
 *    Each chunk is checkpointed, so an interrupted import resumes.
 * 4. Sets the cursor to the snapshot's (unless the database was already further).
 *
 * Stop the indexer first: pages applied here move the cursor as they go.
 */
export async function importSnapshot(
  db: Pick<Pool, 'connect' | 'query'>,
  source: string,
  options: ImportOptions
): Promise<ImportResult> {
  const logger = options.logger ?? defaultLogger;
  const chunkSize = options.chunkSize ?? 500;
  const applyPage = options.applyPage ?? defaultApplyPage();
  const workDir = await mkdtemp(path.join(tmpdir(), 'folder-snapshot-'));
  try {
    let archive = source;
    if (/^https?:\/\//i.test(source)) {
      archive = path.join(workDir, 'download.snapshot');
      logger.info('Downloading snapshot', { url: source });
      await download(source, archive);
    }

    const eventsPath = path.join(workDir, EVENTS_FILE);
    const tar = await readTar(archive, eventsPath);
    const manifest = parseManifest(tar.manifest);
    const expected = manifest.files[EVENTS_FILE];
    if (tar.eventsSha256 !== expected.sha256 || tar.eventsBytes !== expected.bytes) {
      throw new SnapshotError(
        `snapshot checksum mismatch: manifest says sha256 ${expected.sha256} (${expected.bytes} bytes), ` +
          `archive has ${tar.eventsSha256} (${tar.eventsBytes} bytes). The file is corrupt or was tampered with.`
      );
    }

    const state = await readState(db);
    await assertCompatible(db, manifest, options, state);

    // Resume only a checkpoint left by an interrupted import of this same file.
    let saved: Progress | null = null;
    try {
      const raw = state[SNAPSHOT_STATE.progress];
      saved = raw ? (JSON.parse(raw) as Progress) : null;
    } catch {
      saved = null;
    }
    const resumed = saved?.sha256 === expected.sha256;
    const checkpoint: Progress =
      saved && resumed
        ? saved
        : {
            sha256: expected.sha256,
            lastEventId: null,
            priorCursor: state[STATE.cursor] ?? null,
            priorLastLedger: state[STATE.lastLedger] ?? null,
          };
    await writeState(db, {
      [SNAPSHOT_STATE.progress]: JSON.stringify(checkpoint),
      [SNAPSHOT_STATE.networkPassphrase]: manifest.networkPassphrase,
      [SNAPSHOT_STATE.contractId]: manifest.contractId,
    });
    logger.info(resumed ? 'Resuming snapshot import' : 'Importing snapshot', {
      events: manifest.eventCount,
      ledgerRange: manifest.ledgerRange,
      resumeAfter: checkpoint.lastEventId,
    });

    const resumeAfter = resumed ? checkpoint.lastEventId : null;
    const ledgerRange = manifest.ledgerRange ?? { from: 0, to: 0 };
    let seen = 0;
    let applied = 0;
    let skipped = 0;
    let previous: RawEvent | undefined;
    let chunk: RawEvent[] = [];

    const flush = async () => {
      const last = chunk[chunk.length - 1];
      if (!last) return;
      // Pre-create the partition for every ledger in the chunk: the page path
      // only provisions partitions around the chunk's last ledger, and rows for
      // a missing partition would land in the default one.
      for (const ledger of new Set(chunk.map((e) => e.ledger))) await ensurePartitions(db, ledger, 0);
      await applyPage(db, manifest.contractId, {
        events: chunk,
        cursor: last.id,
        latestLedger: ledgerRange.to,
        oldestLedger: ledgerRange.from,
      });
      applied += chunk.length;
      checkpoint.lastEventId = last.id;
      await writeState(db, { [SNAPSHOT_STATE.progress]: JSON.stringify(checkpoint) });
      chunk = [];
    };

    const lines = createInterface({
      input: createReadStream(eventsPath).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (line.length === 0) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        throw new SnapshotError(`snapshot event ${seen + 1} is not valid JSON`);
      }
      if (!validEvent(event, manifest.contractId))
        throw new SnapshotError(`snapshot event ${seen + 1} is malformed`);
      if (previous && compareEventIds(previous.id, event.id) >= 0) {
        throw new SnapshotError(`snapshot events are not in ledger order at ${event.id}`);
      }
      previous = event;
      seen++;
      if (resumeAfter && compareEventIds(event.id, resumeAfter) <= 0) {
        skipped++;
        continue;
      }
      chunk.push(event);
      if (chunk.length >= chunkSize) await flush();
    }
    await flush();
    if (seen !== manifest.eventCount) {
      throw new SnapshotError(`snapshot has ${seen} events but its manifest says ${manifest.eventCount}`);
    }

    // Final cursor: the snapshot's, unless the database was already further.
    const cursor = furthestCursor(checkpoint.priorCursor, manifest.cursor, previous?.id);
    const lastLedger = Math.max(
      Number(checkpoint.priorLastLedger) || 0,
      manifest.lastLedger ?? 0,
      previous?.ledger ?? 0
    );
    await withClient(db, async (client) => {
      await client.query('BEGIN');
      try {
        await writeState(client, {
          [STATE.cursor]: cursor,
          [STATE.startLedger]: null,
          [STATE.lastLedger]: lastLedger > 0 ? String(lastLedger) : null,
          [SNAPSHOT_STATE.progress]: null,
          [SNAPSHOT_STATE.imported]: JSON.stringify({
            sha256: expected.sha256,
            createdAt: manifest.createdAt,
            events: manifest.eventCount,
            ledgerRange: manifest.ledgerRange,
            importedAt: new Date().toISOString(),
          }),
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });

    logger.info('Imported snapshot', { applied, skipped, cursor });
    return { manifest, applied, skipped, resumed, cursor };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function withClient<T>(db: Pick<Pool, 'connect'>, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
