# ADR 0004: PostgreSQL Read Cache

## Decision

Use PostgreSQL for Folder, credential, template, and indexer state tables.

## Rationale

The data is relational, query patterns are simple, and PostgreSQL is reliable for indexed API reads.

## Consequences

- migrations are idempotent
- queries should remain parameterized
- database schema changes must be coordinated with service mappings
