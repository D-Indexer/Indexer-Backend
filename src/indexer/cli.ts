import 'dotenv/config';
import { getEnv } from '../config/env';
import pool from '../db/client';
import { listGaps, markGapFilled, readState, retryRejected, STATE, writeState } from './stellar';

const USAGE = `Usage:
  npm run indexer -- status                 Print indexer state as JSON
  npm run indexer -- reset-cursor <ledger>  Re-index from <ledger> (already-stored events are skipped)
  npm run indexer -- healthcheck            Exit 1 if the indexer has not succeeded recently
                                            (manual use only; containers probe the embedded
                                            /healthz and /readyz HTTP endpoints instead)`;

export async function run(args: string[]): Promise<number> {
  const [command, arg] = args;
  switch (command) {
    case 'status': {
      const state = await readState(pool);
      const ipfs = await pool.query(
        `SELECT status, COUNT(*)::int AS count FROM ipfs_cid_status GROUP BY status`
      );
      const counts: Record<string, number> = {};
      for (const row of ipfs.rows as Array<{ status: string; count: number }>) counts[row.status] = row.count;
      console.log(JSON.stringify({ ...state, ipfs }, null, 2));
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
    case 'gaps': {
      const rest = args.slice(1);
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--open')) {
        console.error('gaps: invalid arguments');
        console.error(USAGE);
        return 2;
      }
      const rows = await listGaps(pool, { openOnly: rest[0] === '--open' });
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    case 'fill-gap': {
      const id = Number(arg);
      if (!Number.isInteger(id) || id <= 0) {
        console.error('fill-gap needs a positive gap id');
        return 2;
      }
      if (!(await markGapFilled(pool, id))) {
        console.error(`fill-gap: no gap with id ${id}`);
        return 1;
      }
      console.log(`Gap ${id} marked filled.`);
      return 0;
    }
    case 'healthcheck': {
      const state = await readState(pool);
      const { stale } = await readStaleness(pool, getEnv().INDEXER_STALE_AFTER_MS);
      if (stale) console.error(`indexer unhealthy: ${JSON.stringify(state)}`);
      return stale ? 1 : 0;
    }
    case 'orphans': {
      const { rows } = await pool.query(
        `SELECT id, ledger, ledger_closed_at, tx_hash, topic, data, indexed_at
           FROM contract_events WHERE status = 'orphaned' ORDER BY ledger, id`
      );
      console.log(JSON.stringify(rows, null, 2));
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
