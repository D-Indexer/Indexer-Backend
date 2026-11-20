import pool from '../db/client';
import { Template } from '../types';
import { cache } from '../cache';

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

const TEMPLATES_TAG = 'templates';
const TEMPLATES_TTL_MS = 60_000;

export async function listTemplates(): Promise<Template[]> {
  return cache.getOrSet<Template[]>(
    'templates:list',
    async () => {
      const { rows } = await pool.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates ORDER BY id`);
      return rows.map(mapTemplate);
    },
    { ttlMs: TEMPLATES_TTL_MS, tags: [TEMPLATES_TAG] },
  );
}

export async function getTemplate(id: number): Promise<Template | null> {
  return cache.getOrSet<Template | null>(
    `templates:${id}`,
    async () => {
      const { rows } = await pool.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates WHERE id = $1`, [id]);
      return rows[0] ? mapTemplate(rows[0]) : null;
    },
    { ttlMs: TEMPLATES_TTL_MS, tags: [TEMPLATES_TAG] },
  );
}