import 'dotenv/config';
import { Pool } from 'pg';
import type { Queryable } from '../db/types';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apiKeys';

const USAGE = `Usage:
  npm run keys -- create --name <integrator> --contact <email or url> [--quota <requests per month>]
  npm run keys -- revoke <id>
  npm run keys -- list

Requires DATABASE_URL and, for create, API_KEY_HMAC_SECRET (the same value the API uses).
The plaintext key is printed once by create and cannot be recovered afterwards.`;

export interface KeysCliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

function parseOptions(args: string[]): { positional: string[]; options: Record<string, string> } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const eq = /^--([a-z]+)=(.*)$/.exec(arg);
    if (eq) {
      options[eq[1] as string] = eq[2] as string;
    } else if (arg.startsWith('--')) {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

export async function run(
  argv: string[],
  db: Queryable,
  secret: string | undefined,
  io: KeysCliIo
): Promise<number> {
  const [command = '', ...rest] = argv;
  try {
    const { positional, options } = parseOptions(rest);
    switch (command) {
      case 'create': {
        const name = options['name']?.trim();
        const contact = options['contact']?.trim();
        if (!name || !contact) throw new Error('create needs --name and --contact');
        if (!secret) throw new Error('API_KEY_HMAC_SECRET is required to create keys');
        let monthlyQuota: number | null = null;
        if (options['quota'] !== undefined) {
          if (!/^\d+$/.test(options['quota']) || Number(options['quota']) < 1) {
            throw new Error('--quota must be a positive integer');
          }
          monthlyQuota = Number(options['quota']);
        }
        const { record, key } = await createApiKey(db, secret, { name, contact, monthlyQuota });
        io.out(
          [
            `Created API key ${record.id} for ${record.name} (${record.contact}), ` +
              `quota: ${record.monthlyQuota ?? 'none'} requests/month.`,
            '',
            `  ${key}`,
            '',
            'This is the only time the key is shown. Send it to the integrator over a secure channel;',
            'they use it as "Authorization: Bearer <key>".',
          ].join('\n')
        );
        return 0;
      }
      case 'revoke': {
        const raw = positional[0];
        if (raw === undefined || !/^\d+$/.test(raw)) throw new Error('revoke needs a numeric key id');
        const record = await revokeApiKey(db, Number(raw));
        if (!record) throw new Error(`No API key with id ${raw}`);
        io.out(
          `Revoked API key ${record.id} (${record.name}) at ${record.revokedAt?.toISOString()}. ` +
            'API replicas reject it once their key cache expires (30s by default).'
        );
        return 0;
      }
      case 'list': {
        const keys = await listApiKeys(db);
        if (keys.length === 0) {
          io.out('No API keys.');
          return 0;
        }
        const rows = keys.map((k) => [
          String(k.id),
          k.name,
          k.contact,
          k.createdAt.toISOString(),
          k.revokedAt ? k.revokedAt.toISOString() : '-',
          k.monthlyQuota === null ? '-' : String(k.monthlyQuota),
          String(k.requestsThisMonth),
        ]);
        const header = ['id', 'name', 'contact', 'created_at', 'revoked_at', 'monthly_quota', 'this_month'];
        const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
        const line = (cells: string[]) =>
          cells
            .map((c, i) => c.padEnd(widths[i] as number))
            .join('  ')
            .trimEnd();
        io.out([line(header), ...rows.map(line)].join('\n'));
        return 0;
      }
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    io.err(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (require.main === module) {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exitCode = 1;
  } else {
    const pool = new Pool({ connectionString });
    run(process.argv.slice(2), pool, process.env['API_KEY_HMAC_SECRET'], {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    })
      .then((code) => {
        process.exitCode = code;
      })
      .finally(() => pool.end());
  }
}
