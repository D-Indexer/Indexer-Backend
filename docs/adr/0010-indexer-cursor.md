# ADR 0010: Indexer Cursor

## Decision

Persist the next ledger cursor in the `indexer_state` table.

## Rationale

The indexer needs restart-safe progress tracking without introducing a separate storage system.

## Consequences

- cursor writes happen after non-empty event batches
- cursor values are stored as strings
- replay can be controlled by editing or clearing the state row
