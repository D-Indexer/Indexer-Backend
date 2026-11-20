# Architecture

Indexer-Backend is the read side of Folder. The
[Folder contract](https://github.com/D-Indexer/Indexer-Contract) on Stellar is the source of
truth; this service turns its events into a Postgres read model and serves it over REST,
and pins portfolio files to IPFS for the [frontend](https://github.com/D-Indexer/Indexer-Frontend).

```mermaid
flowchart LR
  subgraph Stellar
    C[Folder contract]
    RPC[Soroban RPC<br/>getEvents, ~7 day window]
  end
  subgraph Indexer-Backend
    I[Indexer process<br/>src/indexer/main.ts]
    D[Outbox dispatcher<br/>src/outbox/]
    A[API process<br/>src/server.ts]
  end
  DB[(Postgres)]
  K[Kubo / IPFS]
  F[Frontend]
  S[Sinks<br/>noop, log]

  C -- events --> RPC
  I -- poll by cursor --> RPC
  I -- one transaction per page<br/>events + read model + outbox --> DB
  D -- lease rows<br/>FOR UPDATE SKIP LOCKED --> DB
  D -- deliver with retries --> S
  A -- reads --> DB
  A -- add + pin --> K
  F -- REST --> A
  F -- SSE / changes feed --> A
  F -- transactions --> C
```

Two processes share one image and one database. They scale and restart independently, and
the API never talks to the RPC.

| Path                                            | Responsibility                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/indexer/rpc.ts`                            | JSON-RPC client for `getEvents` / `getHealth`: timeouts, retries with backoff, URL redaction                      |
| `src/indexer/decode.ts`                         | Decode raw events (Symbol topic, ScVec data) into typed objects                                                   |
| `src/indexer/handlers.ts`                       | Apply one decoded event to the read model                                                                         |
| `src/indexer/stellar.ts`                        | Poll loop, page transactions, cursor, retention-gap handling                                                      |
| `src/indexer/cli.ts`                            | `status`, `reset-cursor`, `healthcheck`                                                                           |
| `src/outbox/`                                   | Transactional outbox: row model, leased dispatcher, retries/backoff, dead-lettering, `noop` and `log` sinks        |
| `src/routes`, `src/controllers`, `src/services` | REST API: routing, validation, SQL                                                                                |
| `src/config/env.ts`                             | Zod schema for all configuration; the process exits on invalid config                                             |
| `database/schema.sql`                           | The only schema definition; applied by `npm run db:migrate`, the indexer at startup and the compose Postgres init |

## Events

The contract's event format is defined in Indexer-Contract
[`docs/EVENTS.md`](https://github.com/D-Indexer/Indexer-Contract/blob/main/docs/EVENTS.md).
Every event has one `Symbol` topic and an `ScVec` of data fields. Fields are decoded by
position; trailing fields are ignored because the contract only appends.

| Topic       | Data (in order)                                                    | Effect                                                 |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `init`      | `admin`                                                            | insert into `admins`                                   |
| `adm_add`   | `admin`, `new_admin`                                               | insert `new_admin` into `admins`                       |
| `adm_rm`    | `admin`, `target`                                                  | delete `target` from `admins`                          |
| `folder_cl` | `owner`, `folder_name`                                             | upsert `folders`                                       |
| `tmpl_reg`  | `template_id: u32`, `metadata_uri`, `creator` (appended; optional) | upsert `templates`                                     |
| `tmpl_set`  | `owner`, `template_id: u32`                                        | set `folders.template_id` and `portfolios.template_id` |
| `port_mint` | `owner`, `template_id: u32`, `ipfs_cid`                            | upsert `portfolios`; set `folders.template_id`         |
| `port_upd`  | `owner`, `ipfs_cid`                                                | update `portfolios.ipfs_cid`                           |

Timestamps (`claimed_at`, `minted_at`, `updated_at`, …) are the event's `ledgerClosedAt`.
Unknown topics are stored with status `ignored`, so new contract events don't break the
indexer.

To support a new event: add a case to `decode.ts` and `handlers.ts`, a table or column to
`database/schema.sql` if needed, and tests in `decode.test.ts` and `indexer.db.test.ts`.

## How indexing works

1. **Pick a start.** Use the saved RPC paging cursor if there is one. Otherwise use a
   ledger set by `reset-cursor`, then `INDEXER_START_LEDGER`, then the oldest ledger the
   RPC retains.
2. **Fetch a page** with `getEvents`, filtered to `FOLDER_CONTRACT_ID`
   (`INDEXER_PAGE_LIMIT` events).
3. **Write the page in one transaction.** Each event is inserted into `contract_events`
   keyed by its RPC event id (a TOID encoding ledger, transaction, operation and event
   index) with `ON CONFLICT DO NOTHING`. Only newly inserted events are applied to the read
   model. For each applied event, one `outbox` row is written per registered subscriber
   type. The new cursor is written in the same transaction.
4. **Repeat** while pages are full, then sleep `INDEXER_POLL_INTERVAL_MS`.

What this guarantees:

- **Idempotent.** Replaying a page after a crash, or rewinding the cursor, skips events
  already stored. The read model only changes once per event.
- **Atomic.** A failure anywhere in a page rolls back its events, read-model writes, outbox
  rows and cursor together, and the page is retried. A rolled-back page therefore produces
  no outbox rows.
- **No poison pills.** An event that can't be decoded, or that Postgres rejects
  deterministically (constraint or data error), is stored with status `rejected` and its
  error, and indexing continues. `SELECT * FROM contract_events WHERE status = 'rejected'`
  lists them.
- **The cursor always advances.** The RPC returns a cursor even for an empty page, so a quiet
  contract doesn't leave the cursor behind the retention window.
- **Backoff.** RPC calls are retried 3× for timeouts, network errors, 429 and 5xx. Failed
  polls back off exponentially up to `INDEXER_MAX_BACKOFF_MS`.

### Retention window

Soroban RPC only serves recent ledgers (testnet: 120,960 ledgers, about 7 days). If the
saved cursor falls outside that window, for example after the indexer has been down for a
week, the events in between are no longer available from `getEvents`. By default the indexer
halts and reports `retention_gap`; see [operations](operations.md#retention-gap). Backfilling
from archive data is not implemented yet.

## Transactional outbox

Downstream side effects (webhooks, cache purges, message-bus publishing) must act on
exactly the events that were committed, never on events from a rolled-back page, and must
not be lost if the process crashes after commit. Both are handled by a transactional
outbox.

- **Write.** Inside the page transaction, each applied event inserts one `outbox` row per
  registered subscriber type. Rows are only written for newly applied events, so replaying
  a page does not duplicate them.
- **Dispatch.** The dispatcher runs in the indexer process. It leases a batch of pending
  rows with `SELECT … FOR UPDATE SKIP LOCKED`, so multiple dispatchers (for example during
  a rolling restart) never deliver the same row concurrently. Leases expire, so a crashed
  dispatcher's rows are picked up again.
- **Delivery.** Each leased row is handed to the sink registered for its subscriber type.
  Failures are retried with exponential backoff up to a maximum attempt count, after which
  the row moves to the `dead_letter` state and is no longer retried. Inspect dead letters
  with `SELECT * FROM outbox WHERE status = 'dead_letter'`.
- **Guarantee.** Delivery is **at-least-once**: a crash after commit but before delivery
  leaves the row pending, and it is delivered on restart. A crash after delivery but before
  the row is marked delivered causes a redelivery, so sinks must be idempotent.
- **Idempotency key.** Every row carries a stable `idempotency_key` derived from the event
  id and the subscriber type. It is identical across retries and redeliveries; sinks should
  deduplicate on it.
- **Sinks.** `noop` discards the payload (useful for wiring and tests) and `log` writes it
  to the process log. New sinks register against a subscriber type.

The SSE stream and the changes feed read committed rows from Postgres (the read model and
`contract_events`), not from the outbox, so they never observe uncommitted or rolled-back
events. The outbox is the delivery path for external systems.

## Data model

| Table             | Key                     | Source                                                                                         |
| ----------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `contract_events` | RPC event id            | every event: ledger, close time, tx hash, raw topic/value XDR, decoded data, status, error     |
| `folders`         | `owner` (unique `name`) | `folder_cl`, `tmpl_set`, `port_mint`                                                           |
| `templates`       | `id`                    | `tmpl_reg`                                                                                     |
| `portfolios`      | `owner`                 | `port_mint`, `port_upd`, `tmpl_set`                                                            |
| `admins`          | `address`               | `init`, `adm_add`, `adm_rm`                                                                    |
| `indexer_state`   | `key`                   | `cursor`, `last_ledger`, `last_success_at`, `status`, `last_error`, `start_ledger`, `last_gap` |
| `outbox`          | `id` (unique `idempotency_key`) | one row per applied event and subscriber type: payload, status, attempts, next attempt, lease, last error |

Template ids are `BIGINT` because the contract uses `u32`. There are no foreign keys between
`folders` and `portfolios`: an indexer that starts partway through history can see a mint
whose claim is outside the window.

## Design decisions

- **The ledger is the source of truth.** Postgres is a rebuildable read model. Every
  applied event is kept in `contract_events` with its raw XDR.
- **Side effects go through the outbox.** Nothing is emitted directly from the indexing
  loop; rows are committed with the page and delivered at-least-once by the dispatcher.
- **Raw RPC, SDK for XDR.** The SDK's `getEvents` replaces `contractId` and `topic` with
  objects. Calling the JSON-RPC method directly keeps the raw XDR we store, and the SDK is
  used only to decode `ScVal`s.
- **Configuration is validated once at startup** (Zod). A misconfigured process exits
  instead of running half-configured.
- **Graceful shutdown.** On SIGTERM the indexer waits for the in-flight page before closing
  the pool, and the API stops accepting connections first. Both stop after
  `SHUTDOWN_TIMEOUT_MS`.
