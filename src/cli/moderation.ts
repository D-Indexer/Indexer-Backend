import { Command } from 'commander';
import { Pool } from 'pg';
import { ModerationService, ModerationEntityType, ModerationState } from '../services/moderation.service';

interface CliOptions {
  actor?: string;
  reason?: string;
  databaseUrl?: string;
}

function getPool(options: CliOptions): Pool {
  const connectionString =
    options.databaseUrl ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    '';
  if (!connectionString) {
    throw new Error(
      'Database connection string required. Set DATABASE_URL or pass --database-url.'
    );
  }
  return new Pool({ connectionString });
}

function requireActor(options: CliOptions): string {
  const actor = options.actor || process.env.MODERATION_ACTOR;
  if (!actor || actor.trim().length === 0) {
    throw new Error('An actor is required. Pass --actor or set MODERATION_ACTOR.');
  }
  return actor.trim();
}

function requireReason(options: CliOptions): string {
  const reason = options.reason;
  if (!reason || reason.trim().length === 0) {
    throw new Error('A reason is required. Pass --reason.');
  }
  return reason.trim();
}

function parseEntityType(value: string): ModerationEntityType {
  const normalized = value.toLowerCase();
  if (
    normalized === 'folder' ||
    normalized === 'portfolio' ||
    normalized === 'template'
  ) {
    return normalized as ModerationEntityType;
  }
  throw new Error(
    `Invalid entity type "${value}". Expected one of: folder, portfolio, template.`
  );
}

async function runAction(
  action: 'hide' | 'flag' | 'unhide',
  entityTypeRaw: string,
  key: string,
  options: CliOptions
): Promise<void> {
  const entityType = parseEntityType(entityTypeRaw);
  const actor = requireActor(options);
  const pool = getPool(options);
  const service = new ModerationService(pool);

  try {
    if (action === 'unhide') {
      await service.clearModeration(entityType, key, actor, options.reason?.trim());
      // eslint-disable-next-line no-console
      console.log(`Unhid ${entityType} "${key}" (actor: ${actor}).`);
    } else {
      const reason = requireReason(options);
      const state: ModerationState = action === 'hide' ? 'hidden' : 'flagged';
      await service.setModeration(entityType, key, state, reason, actor);
      // eslint-disable-next-line no-console
      console.log(
        `Set ${entityType} "${key}" to "${state}" (actor: ${actor}, reason: ${reason}).`
      );
    }
  } finally {
    await pool.end();
  }
}

export function buildModerationCommand(): Command {
  const program = new Command();
  program
    .name('moderation')
    .description(
      'Moderate folders, portfolios and templates: hide/flag/unhide entries from listings without deleting indexed data.'
    );

  const addCommonOptions = (cmd: Command): Command =>
    cmd
      .option('--actor <actor>', 'Actor performing the action (required)')
      .option('--reason <reason>', 'Reason for the action')
      .option('--database-url <url>', 'Database connection string');

  addCommonOptions(
    program
      .command('hide <entityType> <key>')
      .description('Hide an entry from listings and the directory')
  ).action(async (entityType: string, key: string, options: CliOptions) => {
    await runAction('hide', entityType, key, options);
  });

  addCommonOptions(
    program
      .command('flag <entityType> <key>')
      .description('Flag an entry for review (still visible until hidden)')
  ).action(async (entityType: string, key: string, options: CliOptions) => {
    await runAction('flag', entityType, key, options);
  });

  addCommonOptions(
    program
      .command('unhide <entityType> <key>')
      .description('Remove moderation state so the entry is listed again')
  ).action(async (entityType: string, key: string, options: CliOptions) => {
    await runAction('unhide', entityType, key, options);
  });

  addCommonOptions(
    program
      .command('list [entityType]')
      .description('List current moderation entries (optionally filtered by entity type)')
  ).action(async (entityType: string | undefined, options: CliOptions) => {
    const pool = getPool(options);
    const service = new ModerationService(pool);
    try {
      const filter = entityType ? parseEntityType(entityType) : undefined;
      const entries = await service.listModeration(filter);
      if (entries.length === 0) {
        // eslint-disable-next-line no-console
        console.log('No moderation entries.');
        return;
      }
      for (const entry of entries) {
        // eslint-disable-next-line no-console
        console.log(
          `${entry.entityType}\t${entry.entityKey}\t${entry.state}\t${entry.actor}\t${entry.reason ?? ''}\t${entry.updatedAt.toISOString()}`
        );
      }
    } finally {
      await pool.end();
    }
  });

  addCommonOptions(
    program
      .command('audit [entityType] [key]')
      .description('Show the moderation audit trail')
  ).action(
    async (
      entityType: string | undefined,
      key: string | undefined,
      options: CliOptions
    ) => {
      const pool = getPool(options);
      const service = new ModerationService(pool);
      try {
        const filter = entityType ? parseEntityType(entityType) : undefined;
        const entries = await service.listAudit(filter, key);
        if (entries.length === 0) {
          // eslint-disable-next-line no-console
          console.log('No audit entries.');
          return;
        }
        for (const entry of entries) {
          // eslint-disable-next-line no-console
          console.log(
            `${entry.createdAt.toISOString()}\t${entry.entityType}\t${entry.entityKey}\t${entry.action}\t${entry.state ?? ''}\t${entry.actor}\t${entry.reason ?? ''}`
          );
        }
      } finally {
        await pool.end();
      }
    }
  );

  return program;
}

/* istanbul ignore next */
if (require.main === module) {
  buildModerationCommand()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

export default buildModerationCommand;