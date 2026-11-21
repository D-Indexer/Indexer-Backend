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

export async function listTemplates(network?: string): Promise<Template[]> {
  const { rows } = network
    ? await pool.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates WHERE network = $1 ORDER BY id`, [network])
    : await pool.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates ORDER BY id`);
  return rows.map(mapTemplate);
}

export async function getTemplate(id: number, network?: string): Promise<Template | null> {
  const { rows } = await pool.query<TemplateRow>(
    network ? `SELECT ${COLUMNS} FROM templates WHERE network = $1 AND id = $2` : `SELECT ${COLUMNS} FROM templates WHERE id = $1`,
    network ? [network, id] : [id]
  );
  return rows[0] ? mapTemplate(rows[0]) : null;
}
