/**
 * Snapshot export/import round-trip against Postgres. Skipped unless
 * TEST_DATABASE_URL is set. Uses throwaway schemas as source and target.
 *
 * The page applier here stands in for the indexer's `processPage` (the
 * default `applyPage`): it stores the event through the same insert path and
 * maintains a small deterministic read model, so the test exercises snapshot
 * mechanics (completeness, ordering, checksums, idempotency, resume, cursor)
 * independently of the contract-specific handlers.
 */
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { createReadStream } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../db/migrate';
import type { GetEventsResult, RawEvent } from '../indexer/rpc';
import {
  ApplyPage,
  exportSnapshot,
  importSnapshot,
  SNAPSHOT_STATE,
  SnapshotError,
  type SnapshotManifest,
} from '../indexer/snapshot';
import { ensurePartitions } from '../indexer/partitions';
import { readState, STATE, writeState } from '../indexer/state';
import { insertContractEvent, toStoredXdr } from '../indexer/xdrStorage';
import { addr, makeEvent, OWNER, str, TESTNET_CONTRACT, testnetEvents, u32 } from './eventFixtures';

const url = process.env['TEST_DATABASE_DIRECT_URL'] ?? process.env['TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const silent = { info: () => undefined, warn: () => undefined };

const NETWORK = 'Test SDF Network ; September 2015';
const TARGET = { networkPassphrase: NETWORK, contractId: TESTNET_CONTRACT };

/** Stand-in for processPage: store events idempotently, apply new ones, move the cursor. */
const testApplyPage: ApplyPage = async (db, contractId, page: GetEventsResult) => {
  const client: PoolClient = await db.connect();
  try {
    await client.query('BEGIN');
    for (const event of page.events) {
      const inserted = await insertContractEvent(client, {
        event,
        contractId,
        topic: 'test',
        stored: toStoredXdr(event),
        data: { ledger: event.ledger },
        status: 'applied',
        error: null,
      });
      // Read model: only newly stored events are applied (like processPage).
      if (inserted) {
        await client.query(
          `INSERT INTO admins (address, added_at) VALUES ($1, $2)
           ON CONFLICT (address) DO UPDATE SET added_at = EXCLUDED.added_at`,
          [`${event.txHash}:${event.id}`, event.ledgerClosedAt]
        );
      }
    }
    await writeState(client, { [STATE.cursor]: page.cursor, [STATE.lastLedger]: String(page.latestLedger) });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

function events(): RawEvent[] {
  return [
    ...testnetEvents,
    makeEvent('port_upd', [addr(OWNER), str('bafy-late')], { ledger: 5_700_001 }),
    makeEvent('tmpl_reg', [u32(42), str('ipfs://x')], { ledger: 6_100_000 }), // next partition
  ];
}

async function dump(pool: Pool) {
  const contractEvents = await pool.query(
    `SELECT id, ledger, ledger_closed_at, tx_hash, contract_id, topic, topic_xdr, value_xdr, data, status, error
       FROM contract_events ORDER BY ledger, id`
  );
  const admins = await pool.query('SELECT address, added_at FROM admins ORDER BY address');
  const state = await readState(pool);
  return {
    contractEvents: contractEvents.rows,
    admins: admins.rows,
    cursor: state[STATE.cursor],
    lastLedger: state[STATE.lastLedger],
  };
}

describeDb('indexer snapshots (Postgres)', () => {
  const SOURCE = 'snapshot_source_test';
  const DEST = 'snapshot_target_test';
  let admin: Pool;
  let source: Pool;
  let target: Pool;
  let dir: string;
  let archive: string;
  let manifest: SnapshotManifest;

  const schemaPool = (schema: string) =>
    new Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });

  async function resetTarget(): Promise<void> {
    await admin.query(`DROP SCHEMA IF EXISTS ${DEST} CASCADE; CREATE SCHEMA ${DEST}`);
    await migrate(target, { logger: silent });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SOURCE} CASCADE; CREATE SCHEMA ${SOURCE}`);
    source = schemaPool(SOURCE);
    target = schemaPool(DEST);
    await migrate(source, { logger: silent });

    // Build the source the way the indexer does: pages of events, cursor last.
    const all = events();
    for (let i = 0; i < all.length; i += 4) {
      const chunk = all.slice(i, i + 4);
      for (const e of chunk) await ensurePartitions(source, e.ledger, 0);
      await testApplyPage(source, TESTNET_CONTRACT, {
        events: chunk,
        cursor: chunk[chunk.length - 1]!.id,
        latestLedger: 6_100_100,
        oldestLedger: 5_600_000,
      });
    }
    // Real RPC cursors are past the last event; make the exported one distinct.
    await writeState(source, {
      [STATE.cursor]: '0026199803871232000-0000000005',
      [STATE.lastLedger]: '6100100',
    });

    dir = await mkdtemp(path.join(tmpdir(), 'snapshot-test-'));
    archive = path.join(dir, 'testnet.snapshot');
    manifest = await exportSnapshot(source, archive, { ...TARGET, logger: silent });
  });

  afterAll(async () => {
    await source.end();
    await target.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SOURCE} CASCADE; DROP SCHEMA IF EXISTS ${DEST} CASCADE`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(resetTarget);

  it('writes a manifest describing the export', () => {
    const all = events();
    expect(manifest).toMatchObject({
      format: 'folder-indexer-snapshot',
      formatVersion: 1,
      schemaVersion: 1,
      networkPassphrase: NETWORK,
      contractId: TESTNET_CONTRACT,
      eventCount: all.length,
      ledgerRange: { from: Math.min(...all.map((e) => e.ledger)), to: 6_100_000 },
      cursor: '0026199803871232000-0000000005',
      lastLedger: 6_100_100,
    });
    expect(manifest.files['events.ndjson.gz'].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('export -> import into an empty database yields identical read-model tables and cursor', async () => {
    const result = await importSnapshot(target, archive, {
      ...TARGET,
      applyPage: testApplyPage,
      chunkSize: 3,
      logger: silent,
    });
    expect(result).toMatchObject({ applied: events().length, skipped: 0, resumed: false });
    expect(await dump(target)).toEqual(await dump(source));

    const state = await readState(target);
    expect(state[SNAPSHOT_STATE.progress]).toBeUndefined();
    expect(JSON.parse(state[SNAPSHOT_STATE.imported]!)).toMatchObject({ events: events().length });
    expect(state[SNAPSHOT_STATE.networkPassphrase]).toBe(NETWORK);
  });

  it('is idempotent: importing twice changes nothing', async () => {
    await importSnapshot(target, archive, { ...TARGET, applyPage: testApplyPage, logger: silent });
    const once = await dump(target);
    await importSnapshot(target, archive, { ...TARGET, applyPage: testApplyPage, logger: silent });
    expect(await dump(target)).toEqual(once);
  });

  it('is resumable after an interruption', async () => {
    const pages: number[] = [];
    let calls = 0;
    const crashing: ApplyPage = async (db, contractId, page) => {
      if (++calls === 3) throw new Error('simulated crash');
      pages.push(page.events.length);
      await testApplyPage(db, contractId, page);
    };
    await expect(
      importSnapshot(target, archive, { ...TARGET, applyPage: crashing, chunkSize: 3, logger: silent })
    ).rejects.toThrow('simulated crash');
    expect(pages).toEqual([3, 3]);
    expect(JSON.parse((await readState(target))[SNAPSHOT_STATE.progress]!)).toMatchObject({
      lastEventId: events()
        .map((e) => e.id)
        .sort()[5],
    });

    const resumed = await importSnapshot(target, archive, {
      ...TARGET,
      applyPage: testApplyPage,
      chunkSize: 3,
      logger: silent,
    });
    expect(resumed).toMatchObject({ resumed: true, skipped: 6, applied: events().length - 6 });
    expect(await dump(target)).toEqual(await dump(source));
  });

  it('never rewinds a cursor that is already ahead of the snapshot', async () => {
    const ahead = '0099999999999999999-0000000000';
    await writeState(target, { [STATE.cursor]: ahead });
    const result = await importSnapshot(target, archive, {
      ...TARGET,
      applyPage: testApplyPage,
      logger: silent,
    });
    expect(result.cursor).toBe(ahead);
    expect((await readState(target))[STATE.cursor]).toBe(ahead);
  });

  it('refuses a snapshot for a different network or contract', async () => {
    await expect(
      importSnapshot(target, archive, {
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
        contractId: TESTNET_CONTRACT,
        applyPage: testApplyPage,
        logger: silent,
      })
    ).rejects.toThrow(/snapshot is for network "Test SDF Network ; September 2015"/);
    await expect(
      importSnapshot(target, archive, {
        networkPassphrase: NETWORK,
        contractId: 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K',
        applyPage: testApplyPage,
        logger: silent,
      })
    ).rejects.toThrow(/snapshot is for contract CDDQK74/);
    expect((await dump(target)).contractEvents).toHaveLength(0);
  });

  it('refuses to import into a database that holds another network or contract', async () => {
    await writeState(target, { [SNAPSHOT_STATE.networkPassphrase]: 'Standalone Network ; February 2017' });
    await expect(
      importSnapshot(target, archive, { ...TARGET, applyPage: testApplyPage, logger: silent })
    ).rejects.toThrow(/database holds events for network "Standalone Network/);

    await resetTarget();
    const other = makeEvent('tmpl_reg', [u32(1), str('ipfs://other')], {
      contractId: 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K',
    });
    await ensurePartitions(target, other.ledger, 0);
    await testApplyPage(target, other.contractId, {
      events: [other],
      cursor: other.id,
      latestLedger: other.ledger,
      oldestLedger: 0,
    });
    await expect(
      importSnapshot(target, archive, { ...TARGET, applyPage: testApplyPage, logger: silent })
    ).rejects.toThrow(/database holds events for contract CBQHNAXS/);
  });

  describe('tampering', () => {
    async function tampered(mutate: (bytes: Buffer) => Buffer): Promise<string> {
      const file = path.join(dir, `tampered-${Math.random().toString(36).slice(2)}.snapshot`);
      await writeFile(file, mutate(Buffer.from(await readFile(archive))));
      return file;
    }

    /** Offset of the events entry's data: manifest header + padded manifest + events header. */
    function eventsDataOffset(bytes: Buffer): number {
      const manifestSize = parseInt(bytes.toString('ascii', 124, 135), 8);
      return 512 + Math.ceil(manifestSize / 512) * 512 + 512;
    }

    it('rejects a flipped byte in the events data', async () => {
      const file = await tampered((bytes) => {
        bytes[eventsDataOffset(bytes) + 20] ^= 0xff;
        return bytes;
      });
      await expect(
        importSnapshot(target, file, { ...TARGET, applyPage: testApplyPage, logger: silent })
      ).rejects.toThrow(/snapshot checksum mismatch.*tampered/);
      expect((await dump(target)).contractEvents).toHaveLength(0);
    });

    it('rejects a manifest edited to claim another checksum', async () => {
      const file = await tampered((bytes) => {
        const text = bytes.toString('latin1');
        const sha = manifest.files['events.ndjson.gz'].sha256;
        return Buffer.from(text.replace(sha, sha.replace(/^./, sha[0] === 'a' ? 'b' : 'a')), 'latin1');
      });
      await expect(
        importSnapshot(target, file, { ...TARGET, applyPage: testApplyPage, logger: silent })
      ).rejects.toThrow(/snapshot checksum mismatch/);
    });

    it('rejects a corrupted archive header and a truncated archive', async () => {
      const header = await tampered((bytes) => {
        bytes[10] ^= 0xff; // inside the first entry name: breaks the tar checksum
        return bytes;
      });
      await expect(
        importSnapshot(target, header, { ...TARGET, applyPage: testApplyPage, logger: silent })
      ).rejects.toThrow(/tar header checksum/);

      const truncated = await tampered((bytes) => bytes.subarray(0, eventsDataOffset(bytes) + 10));
      await expect(
        importSnapshot(target, truncated, { ...TARGET, applyPage: testApplyPage, logger: silent })
      ).rejects.toThrow(SnapshotError);
      expect((await dump(target)).contractEvents).toHaveLength(0);
    });
  });

  it('imports from an http(s) URL', async () => {
    const server = createServer((req, res) => {
      if (req.url !== '/testnet.snapshot') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      createReadStream(archive).pipe(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await importSnapshot(target, `http://127.0.0.1:${port}/testnet.snapshot`, {
        ...TARGET,
        applyPage: testApplyPage,
        logger: silent,
      });
      expect(await dump(target)).toEqual(await dump(source));
      await expect(
        importSnapshot(target, `http://127.0.0.1:${port}/missing`, {
          ...TARGET,
          applyPage: testApplyPage,
          logger: silent,
        })
      ).rejects.toThrow(/HTTP 404/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
