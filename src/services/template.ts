import pool from '../db/client';
import { Template } from '../types';

type TemplateRow = {
  id: number;
  metadata_cid: string;
  deprecated: boolean;
  created_at: Date;
};

function mapTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    metadataCid: row.metadata_cid,
    deprecated: row.deprecated,
    createdAt: row.created_at,
  };
}

export async function listTemplates(): Promise<Template[]> {
  const { rows } = await pool.query<TemplateRow>(
    'SELECT * FROM templates WHERE deprecated = FALSE ORDER BY id'
  );
  return rows.map(mapTemplate);
}

export async function getTemplate(id: number): Promise<Template | null> {
  const { rows } = await pool.query<TemplateRow>('SELECT * FROM templates WHERE id = $1', [id]);
  if (!rows[0]) return null;
  return mapTemplate(rows[0]);
}
