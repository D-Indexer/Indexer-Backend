# ADR 0002: Express REST API

## Decision

Use Express for the HTTP API.

## Rationale

The service has a small REST surface, mature middleware needs, and a TypeScript Node.js runtime. Express keeps the API simple and understandable.

## Consequences

- route handlers stay thin
- service modules own persistence calls
- middleware handles cross-cutting request concerns
