import 'dotenv/config';
import { getDirectDatabaseUrl, getEnv } from '../config/env';
import pool from '../db/client';
import { createDirectPool } from '../db/connections';
import { migrate } from '../db/migrate';
import { exportSnapshot, importSnapshot } from './snapshot';
import { readState, STATE, writeState } from './state';

const USAGE = `Usage:
  npm run indexer -- status                 Print indexer state as JSON
  npm run indexer -- reset-cursor <ledger>  Re-index from <ledger> (already-stored events are skipped)
  npm run indexer -- healthcheck            Exit 1 if the indexer has not succeeded recently
                                            (manual use only; containers probe the embedded
                                            /healthz and /readyz HTTP endpoints instead)
  npm run indexer -- export-snapshot <path> Write contract_events + cursor to a verifiable
                                            snapshot archive
  npm run indexer -- import-snapshot <path|url>
                                            Verify and import a snapshot (stop the indexer
                                            first); resumable and idempotent`;

/**
 * Snapshots hold a long export transaction or checkpoint across many
 * transactions, so they run on a direct connection, not through PgBouncer.
 */
async function withDirectPool<T>(fn: (db: ReturnType<typeof createDirectPool>) => Promise<T>): Promise<T> {
  const direct = createDirectPool(getDirectDatabaseUrl(getEnv()));
  try {
    return await fn(direct);
  } finally {
    await direct.end();
  }
}

export async function run(args: string[]): Promise<number> {
  const [command, arg] = args;
  switch (command) {
    case 'status': {
      console.log(JSON.stringify(await readState(pool), null, 2));
      return 0;
    }
    case 'reset-cursor': {
      const ledger = Number(arg);
      if (!Number.isInteger(ledger) || ledger <= 0) {
        console.error('reset-cursor needs a positive ledger number');
        return 2;
      }
      await writeState(pool, {
        [STATE.cursor]: null,
        [STATE.startLedger]: String(ledger),
        [STATE.status]: 'ok',
        [STATE.lastError]: null,
      });
      console.log(`Cursor cleared; the indexer will resume from ledger ${ledger} on its next poll.`);
      return 0;
    }
    case 'healthcheck': {
      const state = await readState(pool);
      const last = Date.parse(state[STATE.lastSuccessAt] ?? '');
      const fresh = Number.isFinite(last) && Date.now() - last < getEnv().INDEXER_STALE_AFTER_MS;
      if (!fresh) console.error(`indexer unhealthy: ${JSON.stringify(state)}`);
      return fresh ? 0 : 1;
    }
    case 'export-snapshot': {
      if (!arg) {
        console.error('export-snapshot needs a destination path');
        return 2;
      }
      const env = getEnv();
      const manifest = await withDirectPool((db) =>
        exportSnapshot(db, arg, {
          networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
          contractId: env.FOLDER_CONTRACT_ID,
        })
      );
      console.log(JSON.stringify(manifest, null, 2));
      return 0;
    }
    case 'import-snapshot': {
      if (!arg) {
        console.error('import-snapshot needs a snapshot path or http(s) URL');
        return 2;
      }
      const env = getEnv();
      const result = await withDirectPool(async (db) => {
        await migrate(db);
        return importSnapshot(db, arg, {
          networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
          contractId: env.FOLDER_CONTRACT_ID,
        });
      });
      console.log(
        JSON.stringify(
          {
            events: result.manifest.eventCount,
            applied: result.applied,
            skipped: result.skipped,
            cursor: result.cursor,
          },
          null,
          2
        )
      );
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
