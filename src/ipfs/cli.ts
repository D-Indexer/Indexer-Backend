/* eslint-disable no-console */
import 'dotenv/config';
import pool from '../db/client';
import { runGc } from './gc';
import { reconcileAll } from './reconcile';

const USAGE = `Usage:
  npm run ipfs -- reconcile                 Reconcile all referenced CIDs once
  npm run ipfs -- gc --older-than 7d [--dry-run]`;

export async function run(args: string[]): Promise<number> {
  const [command] = args;
  if (command === 'reconcile') {
    const result = await reconcileAll(pool);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === 'gc') {
    const older = args.find((arg) => arg.startsWith('--older-than='))?.split('=')[1];
    const olderIndex = args.indexOf('--older-than');
    const rawOlder = older ?? (olderIndex >= 0 ? args[olderIndex + 1] : undefined);
    const match = /^(\d+)d?$/.exec(rawOlder ?? '');
    if (!match) {
      console.error('gc requires --older-than 7d');
      return 2;
    }
    const result = await runGc(pool, {
      olderThanDays: Number(match[1]),
      dryRun: args.includes('--dry-run'),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.error(USAGE);
  return 2;
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
