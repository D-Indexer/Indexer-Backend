import { SorobanRpc, xdr, Address } from '@stellar/stellar-sdk';
import pool from '../db/client';
import { getEnv } from '../config/env';
import { logger } from '../utils/logger';

const CURSOR_KEY = 'indexer_cursor';

export type IndexerDependencies = {
  rpc: Pick<SorobanRpc.Server, 'getEvents'>;
  query: typeof pool.query;
  contractId: string;
  pollIntervalMs: number;
};

export type RunningIndexer = {
  stop: () => void;
};

/** Decode a Soroban ScVal to a plain string, handling Symbol, Str, and Address types */
export function scValToString(raw: string): string {
  const val = xdr.ScVal.fromXDR(raw, 'base64');
  switch (val.switch().name) {
    case 'scvSymbol':
      return val.sym().toString();
    case 'scvString':
      return val.str().toString();
    case 'scvAddress':
      return Address.fromScVal(val).toString();
    case 'scvI128':
    case 'scvU128':
    case 'scvI64':
    case 'scvU64':
    case 'scvU32':
    case 'scvI32':
      return val.value()!.toString();
    default:
      return val.value()?.toString() ?? '';
  }
}

export async function getCursor(query: typeof pool.query = pool.query.bind(pool)): Promise<string> {
  const { rows } = await query(
    'SELECT value FROM indexer_state WHERE key = $1',
    [CURSOR_KEY]
  );
  return rows[0]?.value ?? '0';
}

export async function saveCursor(
  cursor: string,
  query: typeof pool.query = pool.query.bind(pool)
): Promise<void> {
  await query(
    `INSERT INTO indexer_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [CURSOR_KEY, cursor]
  );
}

function requireArgs(eventType: string, args: string[], expectedCount: number): void {
  if (args.length < expectedCount || args.some((arg) => arg === '')) {
    throw new Error(`Malformed ${eventType} event: expected ${expectedCount} populated topic args`);
  }
}

export async function handleEvent(
  event: SorobanRpc.Api.RawEventResponse,
  dependencies: Pick<IndexerDependencies, 'query' | 'contractId'>
): Promise<void> {
  if (event.contractId !== dependencies.contractId) return;

  const topics = event.topic.map(scValToString);
  const [eventType, ...args] = topics;

  switch (eventType) {
    case 'folder_claimed':
    case 'folder_updated': {
      requireArgs(eventType, args, 4);
      const [owner, name, cid, templateId] = args;
      await dependencies.query(
        `INSERT INTO folders (owner, name, cid, template_id, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (owner) DO UPDATE
           SET name = $2, cid = $3, template_id = $4, updated_at = NOW()`,
        [owner, name, cid, Number(templateId)]
      );
      break;
    }
    case 'credential_linked': {
      requireArgs(eventType, args, 3);
      const [owner, platform, proofHash] = args;
      await dependencies.query(
        `INSERT INTO credentials (owner, platform, proof_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (owner, platform) DO UPDATE SET proof_hash = $3`,
        [owner, platform, proofHash]
      );
      break;
    }
    case 'folder_transferred': {
      requireArgs(eventType, args, 2);
      const [owner, recipient] = args;
      await dependencies.query('UPDATE folders SET owner = $2 WHERE owner = $1', [owner, recipient]);
      break;
    }
    case 'template_registered': {
      requireArgs(eventType, args, 2);
      const [templateId, metadataCid] = args;
      await dependencies.query(
        `INSERT INTO templates (id, metadata_cid) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET metadata_cid = $2`,
        [Number(templateId), metadataCid]
      );
      break;
    }
    case 'template_deprecated': {
      requireArgs(eventType, args, 1);
      const [templateId] = args;
      await dependencies.query('UPDATE templates SET deprecated = TRUE WHERE id = $1', [Number(templateId)]);
      break;
    }
    default:
      logger.debug('Ignoring unsupported contract event', { eventType, ledger: event.ledger });
  }
}

export function createIndexer(dependencies: IndexerDependencies): RunningIndexer {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const poll = async () => {
    if (stopped) return;

    try {
      const cursor = await getCursor(dependencies.query);
      const events = await dependencies.rpc.getEvents({
        startLedger: Number(cursor) || undefined,
        filters: [{ type: 'contract', contractIds: [dependencies.contractId] }],
      });

      for (const event of events.events) {
        await handleEvent(event as unknown as SorobanRpc.Api.RawEventResponse, dependencies);
      }

      if (events.events.length > 0) {
        const last = events.events[events.events.length - 1];
        await saveCursor(String(last.ledger + 1), dependencies.query);
      }
    } catch (err) {
      logger.error('Indexer poll failed', { error: err instanceof Error ? err.message : err });
    }

    if (!stopped) {
      timer = setTimeout(poll, dependencies.pollIntervalMs);
    }
  };

  logger.info('Indexer started', {
    contractId: dependencies.contractId,
    pollIntervalMs: dependencies.pollIntervalMs,
  });
  void poll();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      logger.info('Indexer stopped');
    },
  };
}

export function startIndexer(): RunningIndexer {
  const env = getEnv();
  const rpc = new SorobanRpc.Server(env.STELLAR_RPC_URL);

  return createIndexer({
    rpc,
    query: pool.query.bind(pool),
    contractId: env.FOLDER_CONTRACT_ID,
    pollIntervalMs: env.INDEXER_POLL_INTERVAL_MS,
  });
}
