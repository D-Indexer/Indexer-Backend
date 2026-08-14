# ADR 0005: IPFS Pinning

## Decision

Pin uploaded files through the configured Kubo RPC endpoint using Node 20 native `fetch`.

## Rationale

Folder portfolio assets are content-addressed and stored off-chain. Returning a CID lets other system components reference immutable content.

## Consequences

- upload validation runs before pinning
- Kubo availability affects upload success
- gateway URL construction must avoid malformed paths
- the runtime avoids CommonJS/ESM interop risk from ESM-only IPFS client packages
