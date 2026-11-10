import 'dotenv/config';
import { getEnv } from '../config/env';
import pool from '../db/client';
import { readState, STATE, writeState } from './stellar';

const USAGE = `Usage:
  npm run indexer -- status                 Print indexer state as JSON
  npm run indexer -- reset-cursor <ledger>  Re-index from <ledger> (already-stored events are skipped)
  npm run indexer -- healthcheck            Exit 1 if the indexer has not succeeded recently`;

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
