#!/usr/bin/env node
/**
 * CID denylist management CLI (issue #213).
 *
 * Provides an auditable way to add and remove CID denylist entries used to
 * enforce takedowns across upload, gateway proxy, reconciler and API layers.
 *
 * Entries may be provided either as a raw CID or as the community
 * double-hash format `sha256(CID)` (hex), so shared lists can be applied
 * without republishing the underlying CIDs.
 *
 * Usage:
 *   denylist add <cid-or-sha256> --reason <category> --reference <ref> --by <actor>
 *   denylist remove <cid-or-sha256> --by <actor> [--reference <ref>]
 *   denylist list [--limit <n>] [--offset <n>]
 *   denylist check <cid-or-sha256>
 *
 * Examples:
 *   denylist add bafybeigdyrzt... --reason copyright --reference "DMCA-2024-001" --by ops@example.com
 *   denylist add 9f86d081884c7d65... --reason illegal --reference "court-order-42" --by legal@example.com
 *   denylist remove bafybeigdyrzt... --by ops@example.com --reference "appeal-granted"
 *   denylist list --limit 50
 *   denylist check bafybeigdyrzt...
 */

import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

import { getDatabase } from '../db/index.js';

/**
 * Allowed reason categories for a denylist entry. Kept intentionally small so
 * audit reports can be grouped reliably.
 */
export const DENYLIST_REASON_CATEGORIES = [
  'copyright',
  'illegal',
  'personal-data',
  'abuse',
  'other',
] as const;

export type DenylistReasonCategory = (typeof DENYLIST_REASON_CATEGORIES)[number];

export interface DenylistEntry {
  cid: string;
  cidSha256: string;
  reason: DenylistReasonCategory;
  reference: string;
  createdBy: string;
  createdAt: string;
}

export interface DenylistAuditRecord {
  id: number;
  action: 'add' | 'remove';
  cid: string;
  cidSha256: string;
  reason: DenylistReasonCategory | null;
  reference: string | null;
  actor: string;
  createdAt: string;
}

/**
 * Compute the community double-hash format for a CID: `sha256(CID)` as hex.
 */
export function sha256OfCid(cid: string): string {
  return createHash('sha256').update(cid, 'utf8').digest('hex');
}

const HEX_SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * Normalize a user-supplied identifier into both the raw CID (when known) and
 * the sha256 form. If the input is a 64-char hex string it is treated as an
 * already-hashed CID (double-hash format); otherwise it is treated as a raw
 * CID and hashed locally.
 */
export function normalizeIdentifier(input: string): { cid: string | null; cidSha256: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Identifier must not be empty');
  }
  if (HEX_SHA256_RE.test(trimmed)) {
    return { cid: null, cidSha256: trimmed.toLowerCase() };
  }
  return { cid: trimmed, cidSha256: sha256OfCid(trimmed) };
}

function assertReason(value: string): DenylistReasonCategory {
  if (!(DENYLIST_REASON_CATEGORIES as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid reason "${value}". Expected one of: ${DENYLIST_REASON_CATEGORIES.join(', ')}`,
    );
  }
  return value as DenylistReasonCategory;
}

function requireOption(value: string | undefined, name: string): string {
  if (!value || !value.trim()) {
    throw new Error(`Missing required option --${name}`);
  }
  return value.trim();
}

/**
 * Add a denylist entry. Idempotent: re-adding an existing CID updates the
 * reason/reference and records a fresh audit row so the change is traceable.
 */
export async function addEntry(params: {
  identifier: string;
  reason: string;
  reference: string;
  actor: string;
}): Promise<DenylistEntry> {
  const { cid, cidSha256 } = normalizeIdentifier(params.identifier);
  const reason = assertReason(params.reason);
  const reference = requireOption(params.reference, 'reference');
  const actor = requireOption(params.actor, 'by');

  const db = await getDatabase();
  const now = new Date().toISOString();
  // Store the raw CID when known; otherwise store the sha256 as the cid column
  // value so lookups by either form succeed via the cid_sha256 index.
  const storedCid = cid ?? cidSha256;

  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO cid_denylist (cid, cid_sha256, reason, reference, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (cid_sha256) DO UPDATE SET
         reason = excluded.reason,
         reference = excluded.reference,
         created_by = excluded.created_by,
         created_at = excluded.created_at`,
      [storedCid, cidSha256, reason, reference, actor, now],
    );

    await tx.run(
      `INSERT INTO cid_denylist_audit
         (action, cid, cid_sha256, reason, reference, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['add', storedCid, cidSha256, reason, reference, actor, now],
    );
  });

  return {
    cid: storedCid,
    cidSha256,
    reason,
    reference,
    createdBy: actor,
    createdAt: now,
  };
}

/**
 * Remove a denylist entry. Returns true if an entry was removed, false if the
 * identifier was not present. Either way an audit row is recorded.
 */
export async function removeEntry(params: {
  identifier: string;
  actor: string;
  reference?: string;
}): Promise<boolean> {
  const { cid, cidSha256 } = normalizeIdentifier(params.identifier);
  const actor = requireOption(params.actor, 'by');
  const reference = params.reference?.trim() || null;
  const now = new Date().toISOString();

  const db = await getDatabase();
  let removed = false;

  await db.transaction(async (tx) => {
    const existing = await tx.get<{ cid: string }>(
      `SELECT cid FROM cid_denylist WHERE cid_sha256 = ?`,
      [cidSha256],
    );

    if (existing) {
      await tx.run(`DELETE FROM cid_denylist WHERE cid_sha256 = ?`, [cidSha256]);
      removed = true;
    }

    await tx.run(
      `INSERT INTO cid_denylist_audit
         (action, cid, cid_sha256, reason, reference, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['remove', existing?.cid ?? cid ?? cidSha256, cidSha256, null, reference, actor, now],
    );
  });

  return removed;
}

/**
 * Check whether an identifier is currently denylisted.
 */
export async function isDenylisted(identifier: string): Promise<boolean> {
  const { cidSha256 } = normalizeIdentifier(identifier);
  const db = await getDatabase();
  const row = await db.get<{ cid: string }>(
    `SELECT cid FROM cid_denylist WHERE cid_sha256 = ?`,
    [cidSha256],
  );
  return Boolean(row);
}

/**
 * List current denylist entries, newest first.
 */
export async function listEntries(params: {
  limit?: number;
  offset?: number;
} = {}): Promise<DenylistEntry[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 1000));
  const offset = Math.max(0, params.offset ?? 0);
  const db = await getDatabase();
  const rows = await db.all<{
    cid: string;
    cid_sha256: string;
    reason: DenylistReasonCategory;
    reference: string;
    created_by: string;
    created_at: string;
  }>(
    `SELECT cid, cid_sha256, reason, reference, created_by, created_at
       FROM cid_denylist
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows.map((r) => ({
    cid: r.cid,
    cidSha256: r.cid_sha256,
    reason: r.reason,
    reference: r.reference,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

/**
 * List audit records for the denylist, newest first.
 */
export async function listAudit(params: {
  limit?: number;
  offset?: number;
} = {}): Promise<DenylistAuditRecord[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 1000));
  const offset = Math.max(0, params.offset ?? 0);
  const db = await getDatabase();
  const rows = await db.all<{
    id: number;
    action: 'add' | 'remove';
    cid: string;
    cid_sha256: string;
    reason: DenylistReasonCategory | null;
    reference: string | null;
    actor: string;
    created_at: string;
  }>(
    `SELECT id, action, cid, cid_sha256, reason, reference, actor, created_at
       FROM cid_denylist_audit
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    cid: r.cid,
    cidSha256: r.cid_sha256,
    reason: r.reason,
    reference: r.reference,
    actor: r.actor,
    createdAt: r.created_at,
  }));
}

function printUsage(): void {
  process.stderr.write(
    [
      'Usage:',
      '  denylist add <cid-or-sha256> --reason <category> --reference <ref> --by <actor>',
      '  denylist remove <cid-or-sha256> --by <actor> [--reference <ref>]',
      '  denylist list [--limit <n>] [--offset <n>]',
      '  denylist audit [--limit <n>] [--offset <n>]',
      '  denylist check <cid-or-sha256>',
      '',
      `Reason categories: ${DENYLIST_REASON_CATEGORIES.join(', ')}`,
      '',
    ].join('\n'),
  );
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    return command ? 0 : 1;
  }

  switch (command) {
    case 'add': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          reason: { type: 'string' },
          reference: { type: 'string' },
          by: { type: 'string' },
        },
      });
      const identifier = positionals[0];
      if (!identifier) {
        throw new Error('Missing <cid-or-sha256> argument');
      }
      const entry = await addEntry({
        identifier,
        reason: requireOption(values.reason, 'reason'),
        reference: requireOption(values.reference, 'reference'),
        actor: requireOption(values.by, 'by'),
      });
      process.stdout.write(
        `Added denylist entry: cid=${entry.cid} sha256=${entry.cidSha256} reason=${entry.reason} reference=${entry.reference}\n`,
      );
      return 0;
    }

    case 'remove': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          by: { type: 'string' },
          reference: { type: 'string' },
        },
      });
      const identifier = positionals[0];
      if (!identifier) {
        throw new Error('Missing <cid-or-sha256> argument');
      }
      const removed = await removeEntry({
        identifier,
        actor: requireOption(values.by, 'by'),
        reference: values.reference,
      });
      process.stdout.write(
        removed
          ? `Removed denylist entry for ${identifier}\n`
          : `No denylist entry found for ${identifier}\n`,
      );
      return removed ? 0 : 2;
    }

    case 'list': {
      const { values } = parseArgs({
        args: rest,
        options: {
          limit: { type: 'string' },
          offset: { type: 'string' },
        },
      });
      const entries = await listEntries({
        limit: values.limit ? Number(values.limit) : undefined,
        offset: values.offset ? Number(values.offset) : undefined,
      });
      if (entries.length === 0) {
        process.stdout.write('No denylist entries.\n');
        return 0;
      }
      for (const e of entries) {
        process.stdout.write(
          `${e.createdAt}\t${e.reason}\t${e.cid}\t${e.cidSha256}\t${e.reference}\t${e.createdBy}\n`,
        );
      }
      return 0;
    }

    case 'audit': {
      const { values } = parseArgs({
        args: rest,
        options: {
          limit: { type: 'string' },
          offset: { type: 'string' },
        },
      });
      const records = await listAudit({
        limit: values.limit ? Number(values.limit) : undefined,
        offset: values.offset ? Number(values.offset) : undefined,
      });
      if (records.length === 0) {
        process.stdout.write('No audit records.\n');
        return 0;
      }
      for (const r of records) {
        process.stdout.write(
          `${r.createdAt}\t${r.action}\t${r.cid}\t${r.cidSha256}\t${r.reason ?? '-'}\t${r.reference ?? '-'}\t${r.actor}\n`,
        );
      }
      return 0;
    }

    case 'check': {
      const { positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {},
      });
      const identifier = positionals[0];
      if (!identifier) {
        throw new Error('Missing <cid-or-sha256> argument');
      }
      const denied = await isDenylisted(identifier);
      process.stdout.write(denied ? 'denylisted\n' : 'allowed\n');
      return denied ? 0 : 1;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printUsage();
      return 1;
  }
}

// Only run when invoked directly (not when imported by tests).
const isDirectInvocation =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /denylist\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (isDirectInvocation) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    });
}

export { main };