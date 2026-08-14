import pool from '../db/client';
import { Folder, Credential } from '../types';

type FolderRow = {
  owner: string;
  name: string;
  cid: string;
  template_id: number;
  updated_at: Date;
};

type CredentialRow = {
  owner: string;
  platform: string;
  proof_hash: string;
  linked_at: Date;
};

function mapFolder(row: FolderRow): Folder {
  return {
    owner: row.owner,
    name: row.name,
    cid: row.cid,
    templateId: row.template_id,
    updatedAt: row.updated_at,
  };
}

function mapCredential(row: CredentialRow): Credential {
  return {
    owner: row.owner,
    platform: row.platform,
    proofHash: row.proof_hash,
    linkedAt: row.linked_at,
  };
}

export async function getFolderByAddress(owner: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>('SELECT * FROM folders WHERE owner = $1', [owner]);
  if (!rows[0]) return null;
  return mapFolder(rows[0]);
}

export async function getFolderByName(name: string): Promise<Folder | null> {
  const { rows } = await pool.query<FolderRow>('SELECT * FROM folders WHERE name = $1', [name]);
  if (!rows[0]) return null;
  return mapFolder(rows[0]);
}

export async function getCredentials(owner: string): Promise<Credential[]> {
  const { rows } = await pool.query<CredentialRow>(
    'SELECT * FROM credentials WHERE owner = $1 ORDER BY linked_at DESC',
    [owner]
  );
  return rows.map(mapCredential);
}
