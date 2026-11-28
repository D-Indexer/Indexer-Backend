import type { Pool } from 'pg';
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

// Hot SQL paths, exported as named constants so query-plan regression tests
// can run EXPLAIN against the exact statements used in production.
export const LIST_TEMPLATES_SQL = `SELECT ${COLUMNS} FROM templates ORDER BY id`;
export const GET_TEMPLATE_SQL = `SELECT ${COLUMNS} FROM templates WHERE id = $1`;

export async function listTemplates(): Promise<Template[]> {
  const { rows } = await pool.query<TemplateRow>(LIST_TEMPLATES_SQL);
  return rows.map(mapTemplate);
}

export async function getTemplate(id: number): Promise<Template | null> {
  const { rows } = await pool.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? mapTemplate(row) : null;
}