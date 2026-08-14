# ADR 0007: Environment Validation

## Decision

Validate environment configuration during startup.

## Rationale

Failing fast on invalid configuration is safer than allowing partial runtime failures after the server starts.

## Consequences

- required values are explicit in code and docs
- tests provide safe environment defaults
- new configuration must be added to `src/config/env.ts` and `.env.example`
