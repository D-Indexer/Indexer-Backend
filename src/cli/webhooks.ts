import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import { Pool } from 'pg';

interface WebhookSubscriptionRow {
  id: string;
  url: string;
  topics: string[];
  owner: string | null;
  secret: string;
  active: boolean;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

const VALID_TOPICS = ['folder.created', 'mint.created', 'event.created'];

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  return new Pool({ connectionString });
}

function validateUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL must use http or https scheme: ${rawUrl}`);
  }
  if (!parsed.hostname) {
    throw new Error(`URL must include a hostname: ${rawUrl}`);
  }
  return parsed.toString();
}

function parseTopics(raw: string): string[] {
  const topics = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (topics.length === 0) {
    throw new Error('At least one topic is required');
  }
  for (const topic of topics) {
    if (!VALID_TOPICS.includes(topic)) {
      throw new Error(
        `Invalid topic "${topic}". Valid topics: ${VALID_TOPICS.join(', ')}`,
      );
    }
  }
  return Array.from(new Set(topics));
}

function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

function formatRow(row: WebhookSubscriptionRow): string {
  const owner = row.owner ?? '(any)';
  const status = row.active ? 'active' : 'disabled';
  return [
    `id:       ${row.id}`,
    `url:      ${row.url}`,
    `topics:   ${row.topics.join(', ')}`,
    `owner:    ${owner}`,
    `status:   ${status} (failures: ${row.failure_count})`,
    `created:  ${row.created_at}`,
  ].join('\n');
}

async function addCommand(options: {
  url: string;
  topics: string;
  owner?: string;
  secret?: string;
}): Promise<void> {
  const url = validateUrl(options.url);
  const topics = parseTopics(options.topics);
  const owner = options.owner ?? null;
  const secret = options.secret ?? generateSecret();

  const pool = getPool();
  try {
    const result = await pool.query<WebhookSubscriptionRow>(
      `INSERT INTO webhook_subscriptions (url, topics, owner, secret, active, failure_count)
       VALUES ($1, $2, $3, $4, TRUE, 0)
       RETURNING id, url, topics, owner, secret, active, failure_count, created_at, updated_at`,
      [url, topics, owner, secret],
    );
    const row = result.rows[0];
    console.log('Webhook subscription created:');
    console.log(formatRow(row));
    if (!options.secret) {
      console.log(`\nGenerated secret (store securely): ${secret}`);
    }
  } finally {
    await pool.end();
  }
}

async function listCommand(options: { all?: boolean }): Promise<void> {
  const pool = getPool();
  try {
    const where = options.all ? '' : 'WHERE active = TRUE';
    const result = await pool.query<WebhookSubscriptionRow>(
      `SELECT id, url, topics, owner, secret, active, failure_count, created_at, updated_at
       FROM webhook_subscriptions
       ${where}
       ORDER BY created_at DESC`,
    );
    if (result.rows.length === 0) {
      console.log('No webhook subscriptions found.');
      return;
    }
    for (const row of result.rows) {
      console.log(formatRow(row));
      console.log('---');
    }
  } finally {
    await pool.end();
  }
}

async function removeCommand(id: string): Promise<void> {
  const pool = getPool();
  try {
    const result = await pool.query(
      `DELETE FROM webhook_subscriptions WHERE id = $1 RETURNING id`,
      [id],
    );
    if (result.rowCount === 0) {
      throw new Error(`Webhook subscription not found: ${id}`);
    }
    console.log(`Removed webhook subscription ${id}`);
  } finally {
    await pool.end();
  }
}

async function setActive(id: string, active: boolean): Promise<void> {
  const pool = getPool();
  try {
    const result = await pool.query<WebhookSubscriptionRow>(
      `UPDATE webhook_subscriptions
       SET active = $2, failure_count = CASE WHEN $2 THEN 0 ELSE failure_count END, updated_at = NOW()
       WHERE id = $1
       RETURNING id, url, topics, owner, secret, active, failure_count, created_at, updated_at`,
      [id, active],
    );
    if (result.rows.length === 0) {
      throw new Error(`Webhook subscription not found: ${id}`);
    }
    console.log(`Webhook subscription ${id} ${active ? 'enabled' : 'disabled'}.`);
  } finally {
    await pool.end();
  }
}

export function buildWebhooksCommand(): Command {
  const program = new Command('webhooks');
  program.description('Manage webhook subscriptions (admin only)');

  program
    .command('add')
    .description('Add a webhook subscription')
    .requiredOption('--url <url>', 'receiver URL (http or https)')
    .requiredOption('--topics <topics>', `comma-separated topics (${VALID_TOPICS.join(', ')})`)
    .option('--owner <owner>', 'only deliver events for this owner')
    .option('--secret <secret>', 'HMAC secret (generated if omitted)')
    .action(async (options) => {
      await addCommand(options);
    });

  program
    .command('list')
    .description('List webhook subscriptions')
    .option('--all', 'include disabled subscriptions')
    .action(async (options) => {
      await listCommand(options);
    });

  program
    .command('remove')
    .description('Remove a webhook subscription')
    .argument('<id>', 'subscription id')
    .action(async (id: string) => {
      await removeCommand(id);
    });

  program
    .command('enable')
    .description('Enable a webhook subscription')
    .argument('<id>', 'subscription id')
    .action(async (id: string) => {
      await setActive(id, true);
    });

  program
    .command('disable')
    .description('Disable a webhook subscription')
    .argument('<id>', 'subscription id')
    .action(async (id: string) => {
      await setActive(id, false);
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildWebhooksCommand();
  await program.parseAsync(process.argv);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
}