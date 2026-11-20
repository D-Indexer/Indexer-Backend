import type { Pool } from 'pg';
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

export interface TemplateServiceDeps {
  db: Pool;
}

export interface TemplateService {
  listTemplates(): Promise<Template[]>;
  getTemplate(id: number): Promise<Template | null>;
}

export function createTemplateService({ db }: TemplateServiceDeps): TemplateService {
  async function listTemplates(): Promise<Template[]> {
    const { rows } = await db.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates ORDER BY id`);
    return rows.map(mapTemplate);
  }

  async function getTemplate(id: number): Promise<Template | null> {
    const { rows } = await db.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates WHERE id = $1`, [id]);
    return rows[0] ? mapTemplate(rows[0]) : null;
  }

  return { listTemplates, getTemplate };
}