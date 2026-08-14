# ADR 0006: Request IDs

## Decision

Attach a request ID to each response and propagate incoming `x-request-id` when provided.

## Rationale

Request IDs make API failures easier to correlate across clients, logs, and deployment platforms.

## Consequences

- error responses include `requestId`
- health responses include `requestId`
- clients may pass their own correlation ID
