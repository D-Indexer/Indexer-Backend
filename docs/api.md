# API

Base URL locally: `http://localhost:3000`. All responses are JSON. Examples are real
responses from the local stack indexing the testnet contract.

| Method | Path                                             | Purpose                               |
| ------ | ------------------------------------------------ | ------------------------------------- |
| `GET`  | [`/`](#get-)                                     | Service banner                        |
| `GET`  | [`/health`](#get-health)                         | API + database health, indexer status |
| `GET`  | [`/folders/:address`](#get-foldersaddress)       | Folder claimed by an address          |
| `GET`  | [`/folders/name/:name`](#get-foldersnamename)    | Folder by name                        |
| `GET`  | [`/portfolios/:address`](#get-portfoliosaddress) | Portfolio NFT minted by an address    |
| `POST` | [`/portfolios/validate`](#post-portfoliosvalidate) | Validate a portfolio manifest       |
| `GET`  | [`/ipfs/:cid/*`](#get-ipfscid)                   | Content-addressed gateway proxy       |
| `GET`  | [`/templates`](#get-templates)                   | All registered templates              |
| `GET`  | [`/templates/:id`](#get-templatesid)             | One template                          |
| `POST` | [`/upload`](#post-upload)                        | Add and pin a file on IPFS            |
| `POST` | [`/upload/car`](#post-uploadcar)                 | Import a pre-built DAG from a CARv1    |

## Errors

Every error has the same shape:

```json
{ "error": "Invalid Stellar address", "requestId": "0b6f4c2e-5d1a-4c55-9a43-3b2a9f0e8d11" }
```

| Status | When                                                  | `error` examples                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid path parameter or upload                      | `Invalid Stellar address`, `Template ID must be a number`, `Template ID must be at most 4294967295`, `Folder name contains unsupported characters`, `No file provided`, `Unsupported file type`, `File content does not match its declared type`, `File exceeds 10 MB limit`, `Invalid CID`, `Invalid CAR file`, `CAR must have exactly one root`, `CAR block hash mismatch` |
| `404`  | Resource not indexed, unknown route, or unreferenced CID | `Folder not found`, `Portfolio not found`, `Template not found`, `CID not referenced`, `Route not found` (also includes `path`)                                                                                                                                            |
| `422`  | Manifest failed schema validation (`/portfolios/validate`) | `Manifest validation failed` (see `errors[]`)                                                                                                                                                                                                                                |
| `502`  | IPFS node unreachable or returned an error            | `IPFS node unreachable`, `IPFS add failed with status 500`                                                                                                                                                                                                                   |
| `503`  | `/health` only: database unreachable                  | see below                                                                                                                                                                                                                                                                    |
| `504`  | IPFS node timed out (`IPFS_TIMEOUT_MS`)               | `IPFS node timed out`                                                                                                                                                                                                                                                        |
| `500`  | Anything unexpected; details are logged, not returned | `Internal server error`                                                                                                                                                                                                                                                      |

### Request IDs

Every response carries an `x-request-id` header, also echoed as `requestId` in error bodies
and server logs. Send your own `x-request-id` (1–128 characters of `A-Z a-z 0-9 . _ : -`)
to correlate; anything else is replaced with a UUID.

### Validation rules

- `:address` is a Stellar strkey: `G…` (account) or `C…` (contract), 56 characters.
- `:name` is 1–64 characters of `A-Z a-z 0-9 . _ -`. On-chain names end in `.folder`.
- `:id` is a non-negative integer up to `4294967295` (the contract stores `u32`).

## `GET /`

```json
{ "name": "D-Indexer-Backend", "status": "ok", "docs": "/health" }
```

## `GET /health`

`200` when the database responds. The `indexer` block is informational and doesn't
change the status code; the indexer process has its own healthcheck
(see [operations](operations.md#health)).

```json
{
  "status": "ok",
  "db": "ok",
  "indexer": {
    "status": "ok",
    "stale": false,
    "lastLedger": 5654521,
    "lastSuccessAt": "2026-11-10T07:37:30.225Z",
    "lastError": null
  },
  "requestId": "03a1e532-cabc-4f9a-bfd7-b7242bb46db2"
}
```

- `indexer.status`: `ok`, `error` (last poll failed, retrying with backoff),
  `retention_gap` (halted, [needs an operator](operations.md#retention-gap)) or `not_started`.
- `indexer.stale`: no successful poll within `INDEXER_STALE_AFTER_MS`.
- `indexer.lastLedger`: the ledger the indexer has scanned up to.

`503` when the database is unreachable:

```json
{
  "status": "degraded",
  "db": "unreachable",
  "indexer": {
    "status": "not_started",
    "stale": true,
    "lastLedger": null,
    "lastSuccessAt": null,
    "lastError": null
  },
  "requestId": "…"
}
```

## `GET /folders/:address`

Folder claimed by `address` (contract event `folder_cl`). `templateId` is the owner's
selected template (`tmpl_set` / `port_mint`), or `null` if none has been chosen.

```bash
curl localhost:3000/folders/GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM
```

```json
{
  "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
  "name": "smoke-1794262900.folder",
  "templateId": 1,
  "claimedAt": "2026-11-09T22:22:27.000Z",
  "updatedAt": "2026-11-09T22:23:07.000Z"
}
```

Errors: `400` invalid address, `404` `Folder not found`.

## `GET /folders/name/:name`

Same response as above, looked up by folder name.

```bash
curl localhost:3000/folders/name/smoke-1794262900.folder
```

Errors: `400` invalid name, `404` `Folder not found`.

## `GET /portfolios/:address`

Portfolio NFT minted by `address` (`port_mint`; `ipfsCid` follows `port_upd`, `templateId`
follows `tmpl_set`). Timestamps are ledger close times.

```bash
curl localhost:3000/portfolios/GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM
```

```json
{
  "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
  "templateId": 1,
  "ipfsCid": "bafkreifwfa7v77kn2om36djjtqiwqykldpady3ytsfbqkqgcrfilhjqtnu",
  "ipfsCidRaw": "QmYwAPJzv5CZsnAzt8auVZRn6h1b5xVZ8gYb5xVZ8gYb5xVZ8gYb5xVZ8",
  "cidValid": true,
  "mintedAt": "2026-11-09T22:23:07.000Z",
  "updatedAt": "2026-11-09T22:23:52.000Z"
}
```

### CID normalisation

The contract stores `ipfs_cid` as an arbitrary string, so the same content may be minted
as CIDv0 (`Qm…`), CIDv1 base32 (`bafy…`), or another multibase encoding. The indexer
normalises every CID on `port_mint` / `port_upd`:

- `ipfsCidRaw` — the exact string stored on-chain.
- `ipfsCid` — the canonical **CIDv1 base32** form of the same content, or `null` if the
  string is not a parseable CID.
- `cidValid` — `false` when the on-chain string could not be parsed. The event is still
  applied (the portfolio exists), but the problem is visible to clients.

Equality checks (gateway allow-list, dedupe, reconciliation) always use the normalised
`ipfsCid`. Existing rows can be backfilled with `scripts/backfill-cids.ts`.

Errors: `400` invalid address, `404` `Portfolio not found`.

## `POST /portfolios/validate`

Validates a portfolio manifest against the versioned JSON Schema
[`schemas/portfolio-manifest.v1.json`](../schemas/portfolio-manifest.v1.json) (JSON Schema
2020-12). The same validation runs in the bundle upload path, so bad manifests are
rejected at upload time instead of failing at render time.

```bash
curl -X POST localhost:3000/portfolios/validate \
  -H 'content-type: application/json' \
  --data @examples/manifests/valid.json
```

Request body: the manifest object itself.

```json
{
  "schemaVersion": 1,
  "name": "My portfolio",
  "items": [{ "type": "image", "cid": "bafkreiacuprjr4kth5rfldcy4tdq5xfltl22kdlc3es72u4qsqqcb6ypxa" }]
}
```

`200` when valid:

```json
{ "valid": true, "schemaVersion": 1 }
```

`422` when invalid, with one entry per violation (JSON Pointer `path` + human `message`):

```json
{
  "error": "Manifest validation failed",
  "valid": false,
  "schemaVersion": 1,
  "errors": [
    { "path": "/items/0/type", "message": "must be equal to one of the allowed values" },
    { "path": "/name", "message": "must be a string" }
  ],
  "requestId": "…"
}
```

Errors: `400` malformed JSON, `422` schema violations.

### Schema versioning

`schemaVersion` is a required integer field. The policy for evolving it:

- **Additive, backward-compatible changes** (new optional fields, relaxed constraints)
  keep the same `schemaVersion` and are documented in the schema's `$comment`.
- **Breaking changes** (new required fields, removed fields, changed types) bump
  `schemaVersion` and ship a new file `schemas/portfolio-manifest.v<N>.json`. Older
  versions stay published and validated so existing on-chain manifests keep rendering.
- The API validates against the version declared in the manifest; an unknown
  `schemaVersion` is a `422` with `path: "/schemaVersion"`.

## `GET /ipfs/:cid/*`

Content-addressed gateway proxy. Serves content from the local Kubo node **only** for CIDs
referenced by indexed portfolios or templates (or tracked uploads). Any other CID returns
`404` without contacting Kubo, so the service never acts as an open gateway.

```bash
curl -i localhost:3000/ipfs/bafkreiacuprjr4kth5rfldcy4tdq5xfltl22kdlc3es72u4qsqqcb6ypxa
```

Behaviour:

- `:cid` is normalised to CIDv1 base32 before the allow-list check; `Qm…` and `bafy…`
  forms of the same content are equivalent.
- `ETag` is the normalised CID; `Cache-Control: public, max-age=31536000, immutable`.
- `Range` requests are supported and answered with `206` and `Content-Range`.
- `Content-Type` is sniffed from the content; `X-Content-Type-Options: nosniff` is always set.
- Responses carry a restrictive CSP
  (`default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox`) so HTML/SVG
  content cannot execute scripts.
- Content is streamed from Kubo without buffering, so memory use is constant in file size.

Errors: `400` invalid CID, `404` `CID not referenced`, `502` / `504` (IPFS).

## `GET /templates`

All registered templates (`tmpl_reg`), ordered by id. Not paginated yet.

```json
[
  {
    "id": 1,
    "metadataUri": "ipfs://bafkreiejxg6d3gqvi3737mcwxkv4u7gismaraxgv5zfoqtfuc3nbdgve7i",
    "creator": "GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ",
    "registeredAt": "2026-11-09T22:14:42.000Z"
  }
]
```

## `GET /templates/:id`

One template, same shape as a list item.

Errors: `400` invalid id, `404` `Template not found`.

## `POST /upload`

Multipart upload with a single field named `file`. The file is added to the configured
Kubo node with `pin=true` and its CID (v1) returned.

- Allowed types: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.
- The declared type must match the file's leading bytes.
- Maximum size: 10 MB. One file per request.

```bash
curl -F "file=@avatar.png;type=image/png" localhost:3000/upload
# or: examples/curl/upload.sh avatar.png
```

```json
{ "cid": "bafkreiacuprjr4kth5rfldcy4tdq5xfltl22kdlc3es72u4qsqqcb6ypxa" }
```

Errors: `400` (no file, type, size, content mismatch), `502` / `504` (IPFS).

The endpoint is unauthenticated and not rate limited yet; don't expose it publicly
without a proxy that enforces limits.

## `POST /upload/car`

Imports a pre-built DAG from a CARv1 file (advanced clients that build the DAG locally and
know its root CID before upload). Send the CAR as the raw request body
(`content-type: application/vnd.ipld.car`), size-limited like `/upload`.

The server validates the CAR before it reaches Kubo:

- exactly one root;
- every block's multihash matches its CID (a tampered block is rejected);
- files contained in the DAG (UnixFS) obey the same content-type rules as `/upload`.

Valid CARs are imported via Kubo `dag/import` with `pin-roots=true`.

```bash
curl -X POST localhost:3000/upload/car \
  -H 'content-type: application/vnd.ipld.car' \
  --data-binary @portfolio.car
```

```json
{ "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }
```

Errors: `400` (`Invalid CAR file`, `CAR must have exactly one root`, `CAR block hash mismatch`,
disallowed content type, size), `502` / `504` (IPFS).
