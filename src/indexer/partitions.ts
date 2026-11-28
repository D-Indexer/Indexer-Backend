import type { Pool } from 'pg';

/**
 * `contract_events` range partitions. Kept apart from stellar.ts (which
 * re-exports it) so tooling such as snapshots can use it without loading the
 * event decoder.
 */

/** Ledger span covered by each `contract_events` partition. */
export const PARTITION_LEDGER_SPAN = 1_000_000;
/** How many partitions beyond the current one to keep ready. */
export const PARTITION_LOOKAHEAD = 2;

/** Name of the partition covering `ledger` (range [start, start + span)). */
export function partitionNameForLedger(ledger: number, span = PARTITION_LEDGER_SPAN): string {
  const start = Math.floor(ledger / span) * span;
  return `contract_events_p${start}`;
}

/**
 * Create the partition covering `ledger` (and the next `lookahead` ones) if
 * missing, plus the default partition as a safety net. Idempotent and safe to
 * call concurrently: CREATE TABLE IF NOT EXISTS + CREATE ... PARTITION OF are
 * guarded by the catalog, and duplicate-object races are ignored.
 */
export async function ensurePartitions(
  db: Pick<Pool, 'query'>,
  ledger: number,
  lookahead = PARTITION_LOOKAHEAD,
  span = PARTITION_LEDGER_SPAN
): Promise<void> {
  if (!Number.isFinite(ledger) || ledger < 0) return;
  const first = Math.floor(ledger / span) * span;
  for (let i = 0; i <= lookahead; i++) {
    const start = first + i * span;
    const end = start + span;
    const name = `contract_events_p${start}`;
    try {
      await db.query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF contract_events
           FOR VALUES FROM (${start}) TO (${end})`
      );
    } catch (err) {
      // 42P07 duplicate_table / 23505 unique_violation: another worker won the race.
      const code = (err as { code?: unknown })?.code;
      if (code !== '42P07' && code !== '23505') throw err;
    }
  }
  try {
    await db.query('CREATE TABLE IF NOT EXISTS contract_events_default PARTITION OF contract_events DEFAULT');
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code !== '42P07' && code !== '23505') throw err;
  }
}
