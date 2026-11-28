#!/usr/bin/env node
/**
 * Abuse controls CLI.
 *
 * Commands:
 *   top-uploaders [--day YYYY-MM-DD] [--limit N] [--by bytes|files]
 *   block-content <sha256-hash> [--reason TEXT]
 *   block-client <client-hash> [--reason TEXT]
 *   list-blocks [--type content|client]
 *   unblock-content <sha256-hash>
 *   unblock-client <client-hash>
 *
 * Exit codes:
 *   0 success
 *   1 runtime error
 *   2 usage error
 */
import { Pool } from 'pg';

const USAGE = `Usage: abuse <command> [options]

Commands:
  top-uploaders [--day YYYY-MM-DD] [--limit N] [--by bytes|files]
      List top uploaders for a given day (default: today, limit 20, by bytes).

  block-content <sha256-hash> [--reason TEXT]
      Add a SHA-256 content hash to the blocklist.

  block-client <client-hash> [--reason TEXT]
      Block a client hash (salted IP hash or wallet address hash).

  list-blocks [--type content|client]
      List blocklisted content and/or client hashes.

  unblock-content <sha256-hash>
      Remove a content hash from the blocklist.

  unblock-client <client-hash>
      Remove a client hash from the blocklist.

Options:
  --day YYYY-MM-DD   Day to report on (UTC). Defaults to today.
  --limit N          Max rows to return. Defaults to 20.
  --by bytes|files   Sort key for top-uploaders. Defaults to bytes.
  --reason TEXT      Optional reason recorded with a block.
  -h, --help         Show this help.

Environment:
  DATABASE_URL       Postgres connection string (required).
`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = 'true';
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = 'true';
        }
      }
      continue;
    }
    if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function usageError(message: string): never {
  process.stderr.write(`Error: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
}

function isValidSha256(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash);
}

function normalizeHash(hash: string): string {
  return hash.toLowerCase();
}

async function cmdTopUploaders(pool: Pool, args: ParsedArgs): Promise<void> {
  const day = args.flags.day ?? todayUtc();
  if (!isValidDay(day)) {
    usageError(`invalid --day value: ${day} (expected YYYY-MM-DD)`);
  }

  const by = args.flags.by ?? 'bytes';
  if (by !== 'bytes' && by !== 'files') {
    usageError(`invalid --by value: ${by} (expected bytes or files)`);
  }

  const limitRaw = args.flags.limit ?? '20';
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    usageError(`invalid --limit value: ${limitRaw} (expected integer 1-1000)`);
  }

  const orderColumn = by === 'files' ? 'file_count' : 'byte_count';

  const { rows } = await pool.query(
    `SELECT client_hash, byte_count, file_count
       FROM upload_quota_daily
      WHERE day = $1
      ORDER BY ${orderColumn} DESC, client_hash ASC
      LIMIT $2`,
    [day, limit],
  );

  if (rows.length === 0) {
    process.stdout.write(`No uploads recorded for ${day}.\n`);
    return;
  }

  process.stdout.write(`Top uploaders for ${day} (by ${by}):\n\n`);
  process.stdout.write(
    `${'client_hash'.padEnd(66)} ${'bytes'.padStart(14)} ${'files'.padStart(10)}\n`,
  );
  process.stdout.write(`${'-'.repeat(66)} ${'-'.repeat(14)} ${'-'.repeat(10)}\n`);
  for (const row of rows) {
    const clientHash = String(row.client_hash);
    const byteCount = String(row.byte_count ?? 0);
    const fileCount = String(row.file_count ?? 0);
    process.stdout.write(
      `${clientHash.padEnd(66)} ${byteCount.padStart(14)} ${fileCount.padStart(10)}\n`,
    );
  }
}

async function cmdBlockContent(pool: Pool, args: ParsedArgs): Promise<void> {
  const hash = args.positional[0];
  if (!hash) {
    usageError('block-content requires a SHA-256 hash argument');
  }
  if (!isValidSha256(hash)) {
    usageError(`invalid SHA-256 hash: ${hash}`);
  }
  const normalized = normalizeHash(hash);
  const reason = args.flags.reason ?? null;

  await pool.query(
    `INSERT INTO content_blocklist (content_hash, reason)
     VALUES ($1, $2)
     ON CONFLICT (content_hash) DO UPDATE SET reason = EXCLUDED.reason`,
    [normalized, reason],
  );

  process.stdout.write(`Blocked content hash ${normalized}.\n`);
}

async function cmdUnblockContent(pool: Pool, args: ParsedArgs): Promise<void> {
  const hash = args.positional[0];
  if (!hash) {
    usageError('unblock-content requires a SHA-256 hash argument');
  }
  if (!isValidSha256(hash)) {
    usageError(`invalid SHA-256 hash: ${hash}`);
  }
  const normalized = normalizeHash(hash);

  const result = await pool.query(
    `DELETE FROM content_blocklist WHERE content_hash = $1`,
    [normalized],
  );

  if (result.rowCount === 0) {
    process.stdout.write(`Content hash ${normalized} was not blocklisted.\n`);
  } else {
    process.stdout.write(`Unblocked content hash ${normalized}.\n`);
  }
}

async function cmdBlockClient(pool: Pool, args: ParsedArgs): Promise<void> {
  const hash = args.positional[0];
  if (!hash) {
    usageError('block-client requires a client hash argument');
  }
  const normalized = normalizeHash(hash);
  const reason = args.flags.reason ?? null;

  await pool.query(
    `INSERT INTO client_blocklist (client_hash, reason)
     VALUES ($1, $2)
     ON CONFLICT (client_hash) DO UPDATE SET reason = EXCLUDED.reason`,
    [normalized, reason],
  );

  process.stdout.write(`Blocked client hash ${normalized}.\n`);
}

async function cmdUnblockClient(pool: Pool, args: ParsedArgs): Promise<void> {
  const hash = args.positional[0];
  if (!hash) {
    usageError('unblock-client requires a client hash argument');
  }
  const normalized = normalizeHash(hash);

  const result = await pool.query(
    `DELETE FROM client_blocklist WHERE client_hash = $1`,
    [normalized],
  );

  if (result.rowCount === 0) {
    process.stdout.write(`Client hash ${normalized} was not blocklisted.\n`);
  } else {
    process.stdout.write(`Unblocked client hash ${normalized}.\n`);
  }
}

async function cmdListBlocks(pool: Pool, args: ParsedArgs): Promise<void> {
  const type = args.flags.type ?? 'content';
  if (type !== 'content' && type !== 'client') {
    usageError(`invalid --type value: ${type} (expected content or client)`);
  }

  if (type === 'content') {
    const { rows } = await pool.query(
      `SELECT content_hash, reason, created_at
         FROM content_blocklist
        ORDER BY created_at DESC`,
    );
    if (rows.length === 0) {
      process.stdout.write('No blocklisted content hashes.\n');
      return;
    }
    process.stdout.write('Blocklisted content hashes:\n\n');
    for (const row of rows) {
      const reason = row.reason ? ` (${row.reason})` : '';
      process.stdout.write(`${row.content_hash}${reason}\n`);
    }
    return;
  }

  const { rows } = await pool.query(
    `SELECT client_hash, reason, created_at
       FROM client_blocklist
      ORDER BY created_at DESC`,
  );
  if (rows.length === 0) {
    process.stdout.write('No blocklisted client hashes.\n');
    return;
  }
  process.stdout.write('Blocklisted client hashes:\n\n');
  for (const row of rows) {
    const reason = row.reason ? ` (${row.reason})` : '';
    process.stdout.write(`${row.client_hash}${reason}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.help === 'true' || args.command === undefined) {
    process.stdout.write(USAGE);
    process.exit(args.command === undefined && args.flags.help !== 'true' ? 2 : 0);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('Error: DATABASE_URL environment variable is required.\n');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    switch (args.command) {
      case 'top-uploaders':
        await cmdTopUploaders(pool, args);
        break;
      case 'block-content':
        await cmdBlockContent(pool, args);
        break;
      case 'unblock-content':
        await cmdUnblockContent(pool, args);
        break;
      case 'block-client':
        await cmdBlockClient(pool, args);
        break;
      case 'unblock-client':
        await cmdUnblockClient(pool, args);
        break;
      case 'list-blocks':
        await cmdListBlocks(pool, args);
        break;
      default:
        usageError(`unknown command: ${args.command}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});