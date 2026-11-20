import pool from '../db/client';
import { Template } from '../types';

type TemplateRow = {
  id: string; // BIGINT comes back as a string
  metadata_uri: string;
  creator: string | null;
  registered_at: Date;
};

function mapTemplate(row: TemplateRow): Template {
  return {
    id: Number(row.id),
    metadataUri: row.metadata_uri,
    creator: row.creator,
    registeredAt: row.registered_at,
  };
}

const COLUMNS = 'id, metadata_uri, creator, registered_at';

export async function listTemplates(): Promise<Template[]> {
  const { rows } = await pool.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates ORDER BY id`);
  return rows.map(mapTemplate);
}

export async function getTemplate(id: number): Promise<Template | null> {
  const { rows } = await pool.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates WHERE id = $1`, [id]);
  return rows[0] ? mapTemplate(rows[0]) : null;
}

export type TemplateVersion = {
  id: number;
  version: number;
  metadataUri: string;
  creator: string | null;
  eventId: string | null;
  at: Date;
};

type TemplateVersionRow = {
  id: string; // BIGINT comes back as a string
  version: number;
  metadata_uri: string;
  creator: string | null;
  event_id: string | null;
  at: Date;
};

function mapTemplateVersion(row: TemplateVersionRow): TemplateVersion {
  return {
    id: Number(row.id),
    version: Number(row.version),
    metadataUri: row.metadata_uri,
    creator: row.creator,
    eventId: row.event_id,
    at: row.at,
  };
}

export type ListTemplateVersionsOptions = {
  limit?: number;
  cursor?: string | null;
};

export type ListTemplateVersionsResult = {
  versions: TemplateVersion[];
  nextCursor: string | null;
};

const DEFAULT_VERSIONS_LIMIT = 50;
const MAX_VERSIONS_LIMIT = 200;

function encodeVersionCursor(version: number): string {
  return Buffer.from(JSON.stringify({ version }), 'utf8').toString('base64url');
}

function decodeVersionCursor(cursor: string): { version: number } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { version?: unknown };
    if (typeof parsed.version !== 'number' || !Number.isFinite(parsed.version)) {
      throw new Error('invalid cursor');
    }
    return { version: parsed.version };
  } catch {
    throw new HttpError(400, 'Invalid cursor');
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function listTemplateVersions(
  id: number,
  options: ListTemplateVersionsOptions = {},
): Promise<ListTemplateVersionsResult> {
  const rawLimit = options.limit ?? DEFAULT_VERSIONS_LIMIT;
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_VERSIONS_LIMIT);

  const params: unknown[] = [id];
  let where = 'id = $1';
  if (options.cursor) {
    const { version } = decodeVersionCursor(options.cursor);
    params.push(version);
    where += ` AND version < $${params.length}`;
  }
  params.push(limit + 1);

  const { rows } = await pool.query<TemplateVersionRow>(
    `SELECT id, version, metadata_uri, creator, event_id, at
       FROM template_versions
      WHERE ${where}
      ORDER BY version DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const versions = page.map(mapTemplateVersion);
  const nextCursor = hasMore && versions.length > 0 ? encodeVersionCursor(versions[versions.length - 1].version) : null;

  return { versions, nextCursor };
}

type LedgerBounds = {
  earliest: number | null;
  latest: number | null;
};

async function getIndexedLedgerBounds(): Promise<LedgerBounds> {
  const { rows } = await pool.query<{ earliest: string | null; latest: string | null }>(
    `SELECT MIN(ledger)::text AS earliest, MAX(ledger)::text AS latest FROM contract_events`,
  );
  const row = rows[0];
  return {
    earliest: row?.earliest != null ? Number(row.earliest) : null,
    latest: row?.latest != null ? Number(row.latest) : null,
  };
}

type TemplateHistoryRow = TemplateRow & {
  from_ledger: string;
  to_ledger: string | null;
};

export async function getTemplateAtLedger(id: number, ledger: number): Promise<Template | null> {
  if (!Number.isFinite(ledger) || !Number.isInteger(ledger)) {
    throw new HttpError(400, 'atLedger must be an integer');
  }

  const bounds = await getIndexedLedgerBounds();
  if (bounds.earliest === null || bounds.latest === null) {
    throw new HttpError(400, 'No indexed ledgers available');
  }
  if (ledger < bounds.earliest) {
    throw new HttpError(
      400,
      `atLedger ${ledger} is before the earliest indexed ledger (${bounds.earliest})`,
    );
  }
  if (ledger > bounds.latest) {
    throw new HttpError(
      400,
      `atLedger ${ledger} is after the last indexed ledger (${bounds.latest})`,
    );
  }

  const { rows } = await pool.query<TemplateHistoryRow>(
    `SELECT id, metadata_uri, creator, registered_at, from_ledger, to_ledger
       FROM template_history
      WHERE id = $1
        AND from_ledger <= $2
        AND (to_ledger IS NULL OR to_ledger > $2)
      ORDER BY from_ledger DESC
      LIMIT 1`,
    [id, ledger],
  );

  return rows[0] ? mapTemplate(rows[0]) : null;
}