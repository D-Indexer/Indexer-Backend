# ADR 0009: Test Isolation

## Decision

Unit tests mock PostgreSQL, IPFS, and RPC boundaries.

## Rationale

The CI test suite should be deterministic and should not depend on public RPC availability or local infrastructure.

## Consequences

- integration tests can be added separately when services are provisioned
- Jest setup provides safe environment variables
- external modules may need Jest-specific mappers
