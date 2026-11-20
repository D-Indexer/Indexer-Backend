import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getEnv } from '../config/env';
import { recordTiming } from '../middleware/serverTiming';

const env = getEnv();

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_MAX_CONNECTIONS,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
});

const originalQuery = pool.query.bind(pool) as Pool['query'];

// Wrap pool.query to record DB timing into the current request context.
(pool as Pool).query = function instrumentedQuery(
  ...args: Parameters<Pool['query']>
): ReturnType<Pool['query']> {
  const start = process.hrtime.bigint();
  const finish = () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    recordTiming('db', durationMs);
  };

  const result = (originalQuery as (...a: Parameters<Pool['query']>) => ReturnType<Pool['query']>)(
    ...args,
  );

  // pg's query supports both callback and promise styles.
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    return (result as Promise<QueryResult<QueryResultRow>>).then(
      (res) => {
        finish();
        return res;
      },
      (err) => {
        finish();
        throw err;
      },
    ) as ReturnType<Pool['query']>;
  }

  // Callback style: wrap the final callback argument if present.
  const lastArg = args[args.length - 1];
  if (typeof lastArg === 'function') {
    const cb = lastArg as (...cbArgs: unknown[]) => void;
    (args as unknown[])[args.length - 1] = (...cbArgs: unknown[]) => {
      finish();
      cb(...cbArgs);
    };
    return (originalQuery as (...a: Parameters<Pool['query']>) => ReturnType<Pool['query']>)(
      ...args,
    );
  }

  finish();
  return result;
} as Pool['query'];

const originalConnect = pool.connect.bind(pool) as Pool['connect'];

// Wrap pool.connect so that queries issued on a checked-out client are also timed.
(pool as Pool).connect = function instrumentedConnect(
  ...args: Parameters<Pool['connect']>
): ReturnType<Pool['connect']> {
  const result = (originalConnect as (...a: Parameters<Pool['connect']>) => ReturnType<Pool['connect']>)(
    ...args,
  );

  const instrumentClient = (client: PoolClient) => {
    const clientQuery = client.query.bind(client) as PoolClient['query'];
    (client as PoolClient).query = function instrumentedClientQuery(
      ...qArgs: Parameters<PoolClient['query']>
    ): ReturnType<PoolClient['query']> {
      const start = process.hrtime.bigint();
      const finish = () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        recordTiming('db', durationMs);
      };

      const qResult = (clientQuery as (...a: Parameters<PoolClient['query']>) => ReturnType<PoolClient['query']>)(
        ...qArgs,
      );

      if (qResult && typeof (qResult as Promise<unknown>).then === 'function') {
        return (qResult as Promise<QueryResult<QueryResultRow>>).then(
          (res) => {
            finish();
            return res;
          },
          (err) => {
            finish();
            throw err;
          },
        ) as ReturnType<PoolClient['query']>;
      }

      const lastQArg = qArgs[qArgs.length - 1];
      if (typeof lastQArg === 'function') {
        const cb = lastQArg as (...cbArgs: unknown[]) => void;
        (qArgs as unknown[])[qArgs.length - 1] = (...cbArgs: unknown[]) => {
          finish();
          cb(...cbArgs);
        };
        return (clientQuery as (...a: Parameters<PoolClient['query']>) => ReturnType<PoolClient['query']>)(
          ...qArgs,
        );
      }

      finish();
      return qResult;
    } as PoolClient['query'];
    return client;
  };

  if (result && typeof (result as Promise<unknown>).then === 'function') {
    return (result as Promise<PoolClient>).then(instrumentClient) as ReturnType<Pool['connect']>;
  }

  const lastArg = args[args.length - 1];
  if (typeof lastArg === 'function') {
    const cb = lastArg as (...cbArgs: unknown[]) => void;
    (args as unknown[])[args.length - 1] = (err: unknown, client: PoolClient | undefined, done: unknown) => {
      cb(err, client ? instrumentClient(client) : client, done);
    };
    return (originalConnect as (...a: Parameters<Pool['connect']>) => ReturnType<Pool['connect']>)(
      ...args,
    );
  }

  return result;
} as Pool['connect'];

export default pool;