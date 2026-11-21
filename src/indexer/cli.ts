import 'dotenv/config';
import { getEnv } from '../config/env';
import pool from '../db/client';
import { readState, retryRejected, STATE, writeState } from './stellar';

const USAGE = `Usage:
  npm run indexer -- status                 Print indexer state as JSON
  npm run indexer -- reset-cursor <ledger>  Re-index from <ledger> (already-stored events are skipped)
  npm run indexer -- healthcheck            Exit 1 if the indexer has not succeeded recently
  npm run indexer -- retry-rejected [--topic <t>] [--since-ledger <n>] [--dry-run]
                                            Re-decode stored rejected events and apply the ones that now decode`;

type RetryArgs = { topic?: string; sinceLedger?: number; dryRun: boolean };

function parseRetryArgs(args: string[]): RetryArgs | null {
  const parsed: RetryArgs = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--dry-run') {
      parsed.dryRun = true;
    } else if (flag === '--topic' || flag === '--since-ledger') {
      const value = args[++i];
      if (value === undefined) return null;
      if (flag === '--topic') {
        parsed.topic = value;
      } else {
        const ledger = Number(value);
        if (!Number.isInteger(ledger) || ledger <= 0) return null;
        parsed.sinceLedger = ledger;
      }
    } else {
      return null;
    }
  }
  return parsed;
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
        [STATE.cursorRecovered]: null,
      });
      console.log(`Cursor cleared; the indexer will resume from ledger ${ledger} on its next poll.`);
      return 0;
    }
    case 'retry-rejected': {
      const options = parseRetryArgs(args.slice(1));
      if (!options) {
        console.error('retry-rejected: invalid arguments');
        console.error(USAGE);
        return 2;
      }
      const result = await retryRejected(pool, options);
      console.log(JSON.stringify(result, null, 2));
      if (options.dryRun) console.log('Dry run: no changes were written.');
      return 0;
    }
    case 'healthcheck': {
      const state = await readState(pool);
      const last = Date.parse(state[STATE.lastSuccessAt] ?? '');
      const fresh = Number.isFinite(last) && Date.now() - last < getEnv().INDEXER_STALE_AFTER_MS;
      if (!fresh) console.error(`indexer unhealthy: ${JSON.stringify(state)}`);
      return fresh ? 0 : 1;
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
