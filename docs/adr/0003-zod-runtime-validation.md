# ADR 0003: Zod Runtime Validation

## Decision

Validate external input with Zod schemas.

## Rationale

TypeScript validates code at compile time, not runtime input. Zod gives explicit request validation for addresses, template IDs, names, and uploads.

## Consequences

- validation rules live in `src/validation/schemas.ts`
- controllers reject invalid input before service calls
- tests should cover accepted and rejected values
