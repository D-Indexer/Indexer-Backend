/**
 * Raw XDR storage as BYTEA: round-trip and legacy TEXT -> BYTEA conversion.
 * Skipped unless TEST_DATABASE_URL is set. Works in throwaway schemas.
 */
import { xdr } from '@stellar/stellar-base';
import { Pool } from 'pg';
import { migrate } from '../db/migrate';
import { convertContractEventsXdrToBytea, xdrColumnLayout } from '../db/xdrByteaMigration';
import type { RawEvent } from '../indexer/rpc';
import {
  insertContractEvent,
  isCanonicalBase64,
  rowToRawEvent,
  toStoredXdr,
  xdrToBytes,
  XdrEncodingError,
} from '../indexer/xdrStorage';
import { addr, makeEvent, OWNER, str, sym, TESTNET_CONTRACT, testnetEvents, u32 } from './eventFixtures';

const url = process.env['TEST_DATABASE_DIRECT_URL'] ?? process.env['TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const silent = { info: () => undefined, warn: () => undefined };

/** Fixture events plus shapes the testnet sample lacks. */
function fixtureEvents(): RawEvent[] {
  const multiTopic = makeEvent('port_upd', [addr(OWNER), str('bafy-multi')]);
  multiTopic.topic = [sym('port_upd'), addr(OWNER), u32(7)].map((v) => v.toXDR('base64'));
  return [...testnetEvents, multiTopic, makeEvent('tmpl_reg', [u32(4294967295), str('ipfs://max')])];
}

/** Pre-BYTEA layout of contract_events (base64 TEXT columns). */
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
  CREATE TABLE contract_events_p0 PARTITION OF contract_events FOR VALUES FROM (0) TO (1000000);
  CREATE TABLE contract_events_p5000000 PARTITION OF contract_events FOR VALUES FROM (5000000) TO (6000000);
`;

async function insertLegacy(pool: Pool, event: RawEvent): Promise<void> {
  await pool.query(
    `INSERT INTO contract_events
       (id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, status)
     VALUES ($1, $2, $3, $4, $5, '', $6, $7, 'ignored')`,
    [event.id, event.ledger, event.ledgerClosedAt, event.txHash, event.contractId, event.topic, event.value]
  );
}

async function storedEvents(pool: Pool): Promise<RawEvent[]> {
  const { rows } = await pool.query(
    `SELECT id, ledger, ledger_closed_at, tx_hash, contract_id, topic_xdr, value_xdr
       FROM contract_events ORDER BY ledger, id`
  );
  return rows.map(rowToRawEvent);
}

/** The RawEvent fields contract_events stores (fixtures carry a few extra RPC fields). */
function stored(e: RawEvent): RawEvent {
  const { type, ledger, ledgerClosedAt, contractId, id, txHash, topic, value } = e;
  return { type, ledger, ledgerClosedAt, contractId, id, txHash, topic, value };
}

function byId(events: RawEvent[]): RawEvent[] {
  return [...events].map(stored).sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));
}

/** The decoded ScVals of an event, re-serialised for comparison. */
function scVals(event: RawEvent): string[] {
  return [...event.topic, event.value].map((b64) => xdr.ScVal.fromXDR(b64, 'base64').toXDR('base64'));
}

async function columns(pool: Pool, schema: string) {
  const { rows } = await pool.query(
    `SELECT column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'contract_events'
      ORDER BY ordinal_position`,
    [schema]
  );
  return rows;
}

describe('xdrStorage (unit)', () => {
  it('round-trips canonical base64 and refuses anything else', () => {
    for (const event of fixtureEvents()) {
      for (const b64 of [...event.topic, event.value]) {
        expect(isCanonicalBase64(b64)).toBe(true);
        expect(xdrToBytes(b64).toString('base64')).toBe(b64);
      }
    }
    for (const bad of ['not base64!', 'AAA', 'AA=A', 'AAAA\n']) {
      expect(isCanonicalBase64(bad)).toBe(false);
      expect(() => xdrToBytes(bad)).toThrow(XdrEncodingError);
    }
  });

  it('keeps non-base64 XDR verbatim and reports it', () => {
    const stored = toStoredXdr({ topic: [sym('x').toXDR('base64')], value: 'garbage!' });
    expect(stored.error).toMatch(/^value: raw XDR is not canonical base64/);
    expect(stored.valueXdr.toString('utf8')).toBe('garbage!');
    expect(stored.topicXdr[0]!.toString('base64')).toBe(sym('x').toXDR('base64'));
  });
});

describeDb('contract_events raw XDR as BYTEA (Postgres)', () => {
  const FRESH = 'xdr_bytea_fresh_test';
  const LEGACY = 'xdr_bytea_legacy_test';
  let admin: Pool;

  const schemaPool = (schema: string) =>
    new Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` });

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
  });

  beforeEach(async () => {
    await admin.query(
      `DROP SCHEMA IF EXISTS ${FRESH} CASCADE; CREATE SCHEMA ${FRESH};
       DROP SCHEMA IF EXISTS ${LEGACY} CASCADE; CREATE SCHEMA ${LEGACY};`
    );
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${FRESH} CASCADE; DROP SCHEMA IF EXISTS ${LEGACY} CASCADE;`);
    await admin.end();
  });

  it('stores bytes that decode to the same ScVal as the original base64', async () => {
    const pool = schemaPool(FRESH);
    try {
      await migrate(pool, { logger: silent });
      expect(await xdrColumnLayout(pool as never)).toBe('bytea');

      const events = fixtureEvents();
      for (const event of events) {
        const inserted = await insertContractEvent(pool, {
          event,
          contractId: TESTNET_CONTRACT,
          topic: '',
          stored: toStoredXdr(event),
          data: null,
          status: 'ignored',
          error: null,
        });
        expect(inserted).toBe(true);
      }

      const roundTripped = await storedEvents(pool);
      expect(roundTripped).toEqual(byId(events));
      for (const [i, event] of byId(events).entries()) {
        expect(scVals(roundTripped[i]!)).toEqual(scVals(event));
      }

      // Raw bytes in Postgres are exactly the decoded base64, and SQL can still
      // expose base64 via encode() (minus the newlines Postgres inserts every 76 chars).
      const { rows } = await pool.query(
        `SELECT id, translate(encode(value_xdr, 'base64'), E'\\n', '') AS value_b64,
                (SELECT array_agg(translate(encode(t, 'base64'), E'\\n', '') ORDER BY o)
                   FROM unnest(topic_xdr) WITH ORDINALITY AS u(t, o)) AS topic_b64,
                octet_length(value_xdr) AS value_bytes
           FROM contract_events`
      );
      for (const row of rows) {
        const original = events.find((e) => e.id === row.id)!;
        expect(row.value_b64).toBe(original.value);
        expect(row.topic_b64).toEqual(original.topic);
        expect(row.value_bytes).toBe(Buffer.from(original.value, 'base64').length);
      }
    } finally {
      await pool.end();
    }
  });

  it('ignores duplicate inserts', async () => {
    const pool = schemaPool(FRESH);
    try {
      await migrate(pool, { logger: silent });
      const event = testnetEvents[0]!;
      const row = {
        event,
        contractId: TESTNET_CONTRACT,
        topic: '',
        stored: toStoredXdr(event),
        data: null,
        status: 'ignored' as const,
        error: null,
      };
      expect(await insertContractEvent(pool, row)).toBe(true);
      expect(await insertContractEvent(pool, row)).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it('converts a legacy TEXT table in batches, resumes after a failure, and matches a fresh table', async () => {
    const events = fixtureEvents();
    const legacy = schemaPool(LEGACY);
    const fresh = schemaPool(FRESH);
    try {
      await legacy.query(LEGACY_DDL);
      for (const event of events) await insertLegacy(legacy, event);
      // A row whose value is not base64 at all must not block the migration.
      const junk = { ...makeEvent('junk', []), value: 'not base64!' };
      await insertLegacy(legacy, junk);
      expect(await xdrColumnLayout(legacy as never)).toBe('text');

      // Crash after the second batch.
      const client = await legacy.connect();
      try {
        await expect(
          convertContractEventsXdrToBytea(client, {
            batchSize: 3,
            afterBatch: (converted) => {
              if (converted >= 6) throw new Error('simulated crash');
            },
          })
        ).rejects.toThrow('simulated crash');
        expect(await xdrColumnLayout(client)).toBe('converting');
        const { rows } = await client.query(
          'SELECT COUNT(*)::int AS n FROM contract_events WHERE value_xdr_bin IS NULL'
        );
        expect(rows[0].n).toBe(events.length + 1 - 6);

        // Resume: carries on, then swaps the columns into place.
        const resumed = await convertContractEventsXdrToBytea(client, { batchSize: 3 });
        expect(resumed).toMatchObject({ converted: events.length + 1 - 6, swapped: true });
        expect(await xdrColumnLayout(client)).toBe('bytea');
      } finally {
        client.release();
      }

      // Everything round-trips to the original base64 and ScVal.
      const converted = (await storedEvents(legacy)).filter((e) => e.id !== junk.id);
      expect(converted).toEqual(byId(events));
      for (const [i, event] of byId(events).entries()) expect(scVals(converted[i]!)).toEqual(scVals(event));
      const { rows: junkRows } = await legacy.query(
        `SELECT convert_from(value_xdr, 'UTF8') AS v FROM contract_events WHERE id = $1`,
        [junk.id]
      );
      expect(junkRows[0].v).toBe('not base64!');

      // migrate() on the converted table is a no-op, and the result has the
      // same columns, types, nullability and order as a freshly created table.
      await migrate(legacy, { logger: silent });
      await migrate(fresh, { logger: silent });
      expect(await columns(admin, LEGACY)).toEqual(await columns(admin, FRESH));
    } finally {
      await legacy.end();
      await fresh.end();
    }
  });

  it('migrate() converts a legacy table end to end', async () => {
    const legacy = schemaPool(LEGACY);
    try {
      await legacy.query(LEGACY_DDL);
      for (const event of testnetEvents) await insertLegacy(legacy, event);
      const infos: string[] = [];
      await migrate(legacy, { logger: { info: (m: string) => infos.push(m), warn: () => undefined } });
      expect(infos).toContain('contract_events XDR columns are now BYTEA');
      expect(await storedEvents(legacy)).toEqual(byId(testnetEvents));
    } finally {
      await legacy.end();
    }
  });
});
