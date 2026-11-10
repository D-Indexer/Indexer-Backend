import pool from '../db/client';
import { Admin } from '../types';

type AdminRow = {
  address: string;
  added_at: Date;
};

function mapAdmin(row: AdminRow): Admin {
  return {
    address: row.address,
    addedAt: row.added_at,
  };
}

export async function listAdmins(): Promise<Admin[]> {
  const { rows } = await pool.query<AdminRow>(
    'SELECT address, added_at FROM admins ORDER BY added_at ASC, address ASC'
  );
  return rows.map(mapAdmin);
}
