import { Pool } from 'pg';
import { FeatureFlagService, FeatureFlagKey } from '../featureFlags';

interface CliOptions {
  by?: string;
  note?: string;
}

function parseArgs(argv: string[]): { command: string; args: string[]; options: CliOptions } {
  const options: CliOptions = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--by') {
      options.by = argv[++i];
    } else if (arg.startsWith('--by=')) {
      options.by = arg.slice('--by='.length);
    } else if (arg === '--note') {
      options.note = argv[++i];
    } else if (arg.startsWith('--note=')) {
      options.note = arg.slice('--note='.length);
    } else {
      positional.push(arg);
    }
  }

  const [command = '', ...args] = positional;
  return { command, args, options };
}

function usage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Usage:',
      '  flags list',
      '  flags set <key> <on|off> [--by <user>] [--note <text>]',
      '',
      'Examples:',
      '  npm run flags -- list',
      '  npm run flags -- set uploads off --by alice --note "Kubo overloaded"',
    ].join('\n'),
  );
}

function resolveUser(options: CliOptions): string {
  return options.by || process.env.FLAGS_UPDATED_BY || process.env.USER || 'unknown';
}

async function listFlags(service: FeatureFlagService): Promise<void> {
  const flags = await service.listFlags();
  if (flags.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No feature flags configured.');
    return;
  }
  // eslint-disable-next-line no-console
  console.table(
    flags.map((flag) => ({
      key: flag.key,
      enabled: flag.enabled,
      updated_by: flag.updatedBy,
      updated_at: flag.updatedAt instanceof Date ? flag.updatedAt.toISOString() : flag.updatedAt,
      note: flag.note ?? '',
    })),
  );
}

async function setFlag(
  service: FeatureFlagService,
  args: string[],
  options: CliOptions,
): Promise<void> {
  const [key, value] = args;
  if (!key || !value) {
    throw new Error('set requires <key> <on|off>');
  }
  const normalized = value.toLowerCase();
  if (normalized !== 'on' && normalized !== 'off') {
    throw new Error(`Invalid value "${value}"; expected "on" or "off"`);
  }
  const enabled = normalized === 'on';
  const updatedBy = resolveUser(options);

  const flag = await service.setFlag(key as FeatureFlagKey, enabled, updatedBy, options.note);
  // eslint-disable-next-line no-console
  console.log(
    `Flag "${flag.key}" set to ${flag.enabled ? 'on' : 'off'} by ${flag.updatedBy}` +
      (flag.note ? ` (note: ${flag.note})` : ''),
  );
}

export async function run(argv: string[], pool: Pool): Promise<number> {
  const { command, args, options } = parseArgs(argv);
  const service = new FeatureFlagService(pool);

  try {
    switch (command) {
      case 'list':
        await listFlags(service);
        return 0;
      case 'set':
        await setFlag(service, args, options);
        return 0;
      case '':
      case 'help':
      case '--help':
      case '-h':
        usage();
        return 0;
      default:
        // eslint-disable-next-line no-console
        console.error(`Unknown command: ${command}`);
        usage();
        return 1;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // eslint-disable-next-line no-console
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  try {
    const code = await run(process.argv.slice(2), pool);
    process.exitCode = code;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}