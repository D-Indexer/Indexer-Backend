# ADR 0001: Ledger as Source of Truth

## Decision

The Folder contract remains the durable source of truth. PostgreSQL is a rebuildable read model.

## Rationale

Folder ownership, template registration, and credential linkage must be auditable from ledger events. The API needs low-latency reads, so the backend indexes those events into PostgreSQL.

## Consequences

- database state can be rebuilt from events
- event names and topic ordering are compatibility contracts
- migrations should preserve replayability
