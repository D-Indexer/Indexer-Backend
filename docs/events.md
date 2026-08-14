# Folder Event Indexing

The indexer reads Soroban contract events emitted by the Folder contract.

## Supported Events

| Event | Expected topic args | Database effect |
| ----- | ------------------- | --------------- |
| `folder_claimed` | `owner`, `name`, `cid`, `templateId` | upsert `folders` |
| `folder_updated` | `owner`, `name`, `cid`, `templateId` | upsert `folders` |
| `credential_linked` | `owner`, `platform`, `proofHash` | upsert `credentials` |
| `folder_transferred` | `owner`, `recipient` | update `folders.owner` |
| `template_registered` | `templateId`, `metadataCid` | upsert `templates` |
| `template_deprecated` | `templateId` | set `templates.deprecated = TRUE` |

## Cursor Semantics

The indexer stores the next ledger to read in `indexer_state`:

```text
key: indexer_cursor
value: next ledger number as a string
```

After each non-empty event batch, the cursor is set to `lastEvent.ledger + 1`.

## Malformed Events

Events with missing required topic arguments are rejected and logged by the poll loop. The next poll retries from the same saved cursor unless the failure occurred after later events were already persisted.

## Contract Changes

If the Folder contract changes an event name or topic order, update:

- `src/indexer/stellar.ts`
- `src/__tests__/indexer.test.ts`
- `docs/events.md`
- `README.md`
