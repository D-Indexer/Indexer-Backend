/**
 * Measures the storage saved by keeping contract_events raw XDR as BYTEA
 * instead of base64 TEXT.
 *
 *   MEASURE_DATABASE_URL=postgres://... npx tsx scripts/measure-xdr-storage.ts [rows]
 *
 * Builds a legacy (TEXT) contract_events in a throwaway schema with `rows`
 * events (default 200,000) whose topics, values and decoded `data` are cycled
 * from the real testnet fixture events, spread over four 1M-ledger partitions.
 * Then it runs the real batched conversion (src/db/xdrByteaMigration.ts),
 * rewrites each partition with VACUUM FULL, and prints a before/after table.
 * The schema is dropped at the end.
 */
import { scValToNative, xdr } from '@stellar/stellar-base';
import { Pool } from 'pg';
import { convertContractEventsXdrToBytea } from '../src/db/xdrByteaMigration';
import fixture from '../src/__tests__/fixtures/testnet-events.json';

const SCHEMA = 'xdr_storage_measure';
const PARTITION_SPAN = 1_000_000;
const PARTITIONS = 4;

type Sizes = { total: number; heap: number; toast: number; indexes: number; xdrBytesPerRow: number };

const LEGACY_DDL = `
  CREATE TABLE contract_events (
    id TEXT NOT NULL, ledger INTEGER NOT NULL, ledger_closed_at TIMESTAMPTZ NOT NULL,
    tx_hash TEXT NOT NULL, contract_id TEXT NOT NULL, topic TEXT NOT NULL,
    topic_xdr TEXT[] NOT NULL, value_xdr TEXT NOT NULL, data JSONB,
    status TEXT NOT NULL CHECK (status IN ('applied', 'ignored', 'rejected')),
    error TEXT, indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ledger, id)
  ) PARTITION BY RANGE (ledger);
  CREATE TABLE contract_events_default PARTITION OF contract_events DEFAULT;
  CREATE INDEX idx_contract_events_id ON contract_events (id);
  CREATE INDEX idx_contract_events_ledger ON contract_events (ledger);
  CREATE INDEX idx_contract_events_rejected ON contract_events (indexed_at) WHERE status = 'rejected';
  CREATE INDEX idx_contract_events_topic_ledger ON contract_events (topic, ledger);
`;

function decodedData(value: string): string {
  const native = scValToNative(xdr.ScVal.fromXDR(value, 'base64'));
  return JSON.stringify(native, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

async function partitions(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ relid: string }>(
    `SELECT relid::regclass::text AS relid FROM pg_partition_tree('contract_events') WHERE isleaf`
  );
  return rows.map((r) => r.relid);
}

async function measure(pool: Pool): Promise<Sizes> {
  const { rows } = await pool.query(
    `SELECT
       SUM(pg_total_relation_size(relid))::bigint AS total,
       SUM(pg_relation_size(relid))::bigint AS heap,
       SUM(COALESCE(pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0))::bigint AS toast,
       SUM(pg_indexes_size(relid))::bigint AS indexes
     FROM pg_partition_tree('contract_events') t JOIN pg_class c ON c.oid = t.relid
     WHERE t.isleaf`
  );
  const col = await pool.query(
    `SELECT AVG(pg_column_size(topic_xdr) + pg_column_size(value_xdr))::float AS per_row FROM contract_events`
  );
  const r = rows[0];
  return {
    total: Number(r.total),
    heap: Number(r.heap),
    toast: Number(r.toast),
    indexes: Number(r.indexes),
    xdrBytesPerRow: Number(col.rows[0].per_row),
  };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const pct = (before: number, after: number) => `${(((after - before) / before) * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const url = process.env['MEASURE_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('Set MEASURE_DATABASE_URL');
  const rowCount = Number(process.argv[2] ?? 200_000);

  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  const pool = new Pool({ connectionString: url, max: 1, options: `-c search_path=${SCHEMA}` });
  try {
    await pool.query(LEGACY_DDL);
    const firstLedger = 5_000_000;
    for (let i = 0; i < PARTITIONS; i++) {
      const start = firstLedger + i * PARTITION_SPAN;
      await pool.query(
        `CREATE TABLE contract_events_p${start} PARTITION OF contract_events
           FOR VALUES FROM (${start}) TO (${start + PARTITION_SPAN})`
      );
    }

    const templates = fixture.events.map((e) => ({ ...e, data: decodedData(e.value) }));
    const step = Math.floor((PARTITIONS * PARTITION_SPAN) / rowCount) || 1;
    const BATCH = 5000;
    for (let offset = 0; offset < rowCount; offset += BATCH) {
      const n = Math.min(BATCH, rowCount - offset);
      const cols: unknown[][] = [[], [], [], [], [], [], [], [], []];
      for (let k = 0; k < n; k++) {
        const i = offset + k;
        const t = templates[i % templates.length]!;
        const ledger = firstLedger + i * step;
        const id = `${(BigInt(ledger) << 32n).toString().padStart(19, '0')}-${String(i % 10).padStart(10, '0')}`;
        const row = [
          id,
          ledger,
          t.ledgerClosedAt,
          t.txHash,
          t.contractId,
          'topic',
          `{${t.topic.join(',')}}`,
          t.value,
          t.data,
        ];
        row.forEach((v, c) => cols[c]!.push(v));
      }
      await pool.query(
        `INSERT INTO contract_events (id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status)
         SELECT id, ledger, closed, tx, cid, topic, txdr::text[], vxdr, data::jsonb, 'applied'
         FROM unnest($1::text[], $2::int[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
           AS u(id, ledger, closed, tx, cid, topic, txdr, vxdr, data)`,
        cols
      );
    }
    await pool.query('VACUUM ANALYZE contract_events');
    const before = await measure(pool);

    const client = await pool.connect();
    const started = Date.now();
    let result;
    try {
      result = await convertContractEventsXdrToBytea(client);
    } finally {
      client.release();
    }
    const convertMs = Date.now() - started;
    const afterConvert = await measure(pool);
    for (const p of await partitions(pool)) await pool.query(`VACUUM FULL ${p}`);
    await pool.query('ANALYZE contract_events');
    const after = await measure(pool);

    const pgVersion = (await pool.query('SHOW server_version')).rows[0].server_version;
    console.log(
      `Rows: ${rowCount.toLocaleString()} (cycled from ${templates.length} testnet fixture events), ` +
        `PostgreSQL ${pgVersion}, ${PARTITIONS} partitions`
    );
    console.log(
      `Conversion: ${result.converted.toLocaleString()} rows in ${result.batches} batches, ${(convertMs / 1000).toFixed(1)}s\n`
    );
    console.log('| | TEXT (base64) | BYTEA, before VACUUM FULL | BYTEA after VACUUM FULL | Change |');
    console.log('| --- | ---: | ---: | ---: | ---: |');
    const line = (label: string, f: (s: Sizes) => number, fmt: (n: number) => string) =>
      console.log(
        `| ${label} | ${fmt(f(before))} | ${fmt(f(afterConvert))} | ${fmt(f(after))} | ${pct(f(before), f(after))} |`
      );
    line(
      'XDR column bytes / row',
      (s) => s.xdrBytesPerRow,
      (n) => n.toFixed(1)
    );
    line('Heap', (s) => s.heap, mb);
    line('TOAST', (s) => s.toast, mb);
    line('Indexes', (s) => s.indexes, mb);
    line('Total (heap + TOAST + indexes)', (s) => s.total, mb);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
