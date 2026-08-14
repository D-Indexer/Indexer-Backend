# Testing

## Commands

```bash
npm run typecheck
npm test
npm run build
```

`npm run check` runs typechecking and tests.

## Current Coverage Focus

The current Jest suite covers:

- environment validation
- Folder service row mapping and parameterized queries
- upload controller validation and IPFS call behavior
- indexer cursor helpers
- indexer event handling for core Folder events

## Test Environment

`src/__tests__/jest.env.ts` provides safe test environment variables so modules that validate configuration can load during tests.

## Adding Tests

When adding route, service, or indexer behavior:

1. prefer unit tests for mapping and validation
2. mock PostgreSQL and external RPC clients
3. add integration tests only when the required services can be started reliably in CI
4. avoid tests that depend on public RPC availability
