import type { PoolClient } from 'pg';

/**
 * Anything that can run a query: a Pool, a checked-out PoolClient or a Client.
 * Services and indexer helpers take this instead of importing the global pool,
 * so they can run inside the indexer's page transaction and be tested against
 * a real Postgres or a fake.
 */
export type Queryable = Pick<PoolClient, 'query'>;
