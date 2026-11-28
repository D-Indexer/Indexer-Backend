import type { PoolClient } from 'pg';

/**
 * Converts `contract_events.topic_xdr TEXT[]` / `value_xdr TEXT` (base64) to
 * `BYTEA[]` / `BYTEA` on databases created before the BYTEA layout.
 *
 * Runs from `migrate()` after the schema, while the migration advisory lock is
 * held, so only one process converts at a time. It is:
 *
 * - **Batched**: rows are converted in keyset-ordered batches on the primary
 *   key `(ledger, id)`, each batch its own short transaction, so no single
 *   statement rewrites the whole table or holds long row locks.
 * - **Resumable**: progress lives in the data (new `*_bin` columns are NULL
 *   until a row is converted). After a crash, the next `migrate()` carries on
 *   and skips converted rows.
 * - **Online until the swap**: old-version writers can keep inserting TEXT rows
 *   while batches run. The final swap takes an ACCESS EXCLUSIVE lock, converts
 *   any stragglers, drops the TEXT columns and renames the BYTEA ones into
 *   place, in one transaction.
 *
 * Postgres does not return the space of dropped columns until the table is
 * rewritten: run `VACUUM FULL` (or pg_repack) per partition afterwards. See
 * docs/operations.md#raw-xdr-storage-bytea.
 */

type Logger = { info: (msg: string, ctx?: Record<string, unknown>) => void };

export const DEFAULT_XDR_BATCH_SIZE = 5000;

/**
 * base64 text -> bytes. Text that is not valid padded base64 (only ever on a
 * rejected event) is kept verbatim as UTF-8, matching src/indexer/xdrStorage.ts,
 * instead of failing the whole migration on one bad row.
 */
const decodeExpr = (col: string) =>
  `CASE WHEN ${col} ~ '^[A-Za-z0-9+/]*={0,2}$' AND length(${col}) % 4 = 0
        THEN decode(${col}, 'base64') ELSE convert_to(${col}, 'UTF8') END`;

const SET_CONVERTED = `
  topic_xdr_bin = ARRAY(
    SELECT ${decodeExpr('u.t')}
    FROM unnest(ce.topic_xdr) WITH ORDINALITY AS u(t, ord)
    ORDER BY u.ord
  )::bytea[],
  value_xdr_bin = ${decodeExpr('ce.value_xdr')}`;

export type XdrColumnLayout = 'bytea' | 'text' | 'converting' | 'missing';

/** Which layout `contract_events` in the current schema has. */
export async function xdrColumnLayout(db: Pick<PoolClient, 'query'>): Promise<XdrColumnLayout> {
  const { rows } = await db.query<{ column_name: string; udt_name: string }>(
    `SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'contract_events'
        AND column_name IN ('value_xdr', 'value_xdr_bin')`
  );
  const value = rows.find((r) => r.column_name === 'value_xdr');
  if (!value) return 'missing';
  if (value.udt_name === 'bytea') return 'bytea';
  return rows.some((r) => r.column_name === 'value_xdr_bin') ? 'converting' : 'text';
}

export type ConvertOptions = {
  batchSize?: number;
  logger?: Logger;
  /** Test hook, called after each committed batch. */
  afterBatch?: (converted: number) => Promise<void> | void;
};

export type ConvertResult = { converted: number; batches: number; swapped: boolean };

/**
 * Convert legacy TEXT XDR columns to BYTEA. A no-op on a BYTEA (or new) table.
 * `client` must not be inside a transaction; each batch commits on its own.
 */
export async function convertContractEventsXdrToBytea(
  client: Pick<PoolClient, 'query'>,
  options: ConvertOptions = {}
): Promise<ConvertResult> {
  const batchSize = options.batchSize ?? DEFAULT_XDR_BATCH_SIZE;
  const logger = options.logger;
  const layout = await xdrColumnLayout(client);
  if (layout === 'bytea' || layout === 'missing') return { converted: 0, batches: 0, swapped: false };

  logger?.info(
    layout === 'text'
      ? 'Converting contract_events XDR columns from base64 TEXT to BYTEA'
      : 'Resuming contract_events XDR conversion to BYTEA',
    { batchSize }
  );

  // Adding nullable columns without a default is a catalog-only change.
  await client.query(
    `ALTER TABLE contract_events
       ADD COLUMN IF NOT EXISTS topic_xdr_bin BYTEA[],
       ADD COLUMN IF NOT EXISTS value_xdr_bin BYTEA`
  );

  let converted = 0;
  let batches = 0;
  // Keyset cursor over the primary key; (-1, '') sorts before every row.
  let lo: { ledger: number; id: string } = { ledger: -1, id: '' };
  for (;;) {
    // Upper bound of this batch: the batchSize-th key after `lo`, or open-ended.
    const { rows: bound } = await client.query<{ ledger: number; id: string }>(
      `SELECT ledger, id FROM contract_events
        WHERE (ledger, id) > ($1, $2)
        ORDER BY ledger, id
        OFFSET $3 LIMIT 1`,
      [lo.ledger, lo.id, batchSize - 1]
    );
    const hi = bound[0];
    const updated = await client.query(
      `UPDATE contract_events ce SET ${SET_CONVERTED}
        WHERE (ce.ledger, ce.id) > ($1, $2)
          ${hi ? 'AND (ce.ledger, ce.id) <= ($3, $4)' : ''}
          AND ce.value_xdr_bin IS NULL`,
      hi ? [lo.ledger, lo.id, hi.ledger, hi.id] : [lo.ledger, lo.id]
    );
    batches++;
    converted += updated.rowCount ?? 0;
    if ((updated.rowCount ?? 0) > 0) {
      logger?.info('Converted contract_events XDR batch', { batch: batches, converted, upTo: hi ?? 'end' });
    }
    await options.afterBatch?.(converted);
    if (!hi) break;
    lo = hi;
  }

  // Swap in one transaction. ACCESS EXCLUSIVE blocks old-version writers for
  // the (short) duration, so no TEXT row can slip in after the catch-up.
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE contract_events IN ACCESS EXCLUSIVE MODE');
    const stragglers = await client.query(
      `UPDATE contract_events ce SET ${SET_CONVERTED} WHERE ce.value_xdr_bin IS NULL`
    );
    converted += stragglers.rowCount ?? 0;
    await client.query('ALTER TABLE contract_events DROP COLUMN topic_xdr, DROP COLUMN value_xdr');
    await client.query('ALTER TABLE contract_events RENAME COLUMN topic_xdr_bin TO topic_xdr');
    await client.query('ALTER TABLE contract_events RENAME COLUMN value_xdr_bin TO value_xdr');
    await client.query(
      `ALTER TABLE contract_events
         ALTER COLUMN topic_xdr SET NOT NULL,
         ALTER COLUMN value_xdr SET NOT NULL`
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }

  logger?.info('contract_events XDR columns are now BYTEA', {
    converted,
    batches,
    next: 'VACUUM FULL (or pg_repack) each contract_events partition to reclaim the space',
  });
  return { converted, batches, swapped: true };
}
