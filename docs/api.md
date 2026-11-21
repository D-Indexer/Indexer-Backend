# API

Base URL locally: `http://localhost:3000`. All responses are JSON. Examples are real
responses from the local stack indexing the testnet contract.

| Method | Path                                             | Purpose                               |
| ------ | ------------------------------------------------ | ------------------------------------- |
| `GET`  | [`/`](#get-)                                     | Service banner                        |
| `GET`  | [`/health`](#get-health)                         | API + database health, indexer status |
| `GET`  | [`/folders`](#get-folders)                       | Folders ordered by claim time         |
| `GET`  | [`/folders/:address`](#get-foldersaddress)       | Folder claimed by an address          |
| `GET`  | [`/folders/name/:name`](#get-foldersnamename)    | Folder by name                        |
| `POST` | [`/folders/lookup`](#post-folderslookup)         | Batch folder lookup by address        |
| `GET`  | [`/portfolios`](#get-portfolios)                 | Portfolios ordered by mint/update time |
| `GET`  | [`/portfolios/:address`](#get-portfoliosaddress) | Portfolio NFT minted by an address    |
| `POST` | [`/portfolios/lookup`](#post-portfolioslookup)   | Batch portfolio lookup by address     |
| `GET`  | [`/nft/:tokenId/metadata`](#get-nfttokenidmetadata) | ERC-721-style metadata for a portfolio NFT |
| `GET`  | [`/templates`](#get-templates)                   | All registered templates              |
| `GET`  | [`/templates/:id`](#get-templatesid)             | One template                          |
| `POST` | [`/upload`](#post-upload)                        | Add and pin a file on IPFS            |

## Errors

Every error has the same shape:

```json
{ "error": "Invalid Stellar address", "requestId": "0b6f4c2e-5d1a-4c55-9a43-3b2a9f0e8d11" }
```

| Status | When                                                  | `error` examples                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid path parameter or upload                      | `Invalid Stellar address`, `Template ID must be a number`, `Template ID must be at most 4294967295`, `Folder name contains unsupported characters`, `No file provided`, `Unsupported file type`, `File content does not match its declared type`, `File exceeds 10 MB limit` |
| `404`  | Resource not indexed, or unknown route                | `Folder not found`, `Portfolio not found`, `Template not found`, `Route not found` (also includes `path`)                                                                                                                                                                    |
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

## `GET /folders`

Keyset-paginated list of folders ordered by `claimed_at` (ascending, ties broken by owner).
Hidden (moderated) folders are excluded.

Query params:

- `order` — only `claimed_at` (default).
- `limit` — 1–100, default 20.
- `cursor` — opaque cursor from the previous page's `nextCursor`.

```bash
curl 'localhost:3000/folders?limit=2'
```

```json
{
  "items": [
    {
      "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
      "name": "smoke-1794262900.folder",
      "templateId": 1,
      "claimedAt": "2026-11-09T22:22:27.000Z",
      "updatedAt": "2026-11-09T22:23:07.000Z"
    }
  ],
  "nextCursor": "djE6Y2xhaW1lZF9hdDoyMDI2LTExLTA5VDIyOjIyOjI3LjAwMFo6R0FQQU1UVFZIQjdSWjVEUUhFSU5aTjNHUVlSQ1hYV05DUU5RU1k1WUFVNktSUVVZWDJRSlQyQ00"
}
```

Pass `nextCursor` back as `cursor` to get the next page; `nextCursor` is `null` on the last
page. Cursors are opaque and versioned: a tampered, malformed, or wrong-`order` cursor
returns `400 Invalid cursor`. Pagination is stable under concurrent inserts (no duplicates
or gaps) because the cursor is a strict `(claimed_at, owner)` comparison.

Errors: `400` invalid `order`, `limit`, or `cursor`.

## `GET /portfolios`

Keyset-paginated list of portfolios ordered by `minted_at` (default) or `updated_at`
(ascending, ties broken by owner). Hidden (moderated) portfolios are excluded.

Query params: `order` (`minted_at` | `updated_at`), `limit` (1–100, default 20), `cursor`.
Response shape is `{ "items": [...], "nextCursor": "…" | null }` with the same item shape as
[`GET /portfolios/:address`](#get-portfoliosaddress).

```bash
curl 'localhost:3000/portfolios?order=updated_at&limit=20'
```

Errors: `400` invalid `order`, `limit`, or `cursor`.

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
  "mintedAt": "2026-11-09T22:23:07.000Z",
  "updatedAt": "2026-11-09T22:23:52.000Z"
}
```

Errors: `400` invalid address, `404` `Portfolio not found`.

## `POST /folders/lookup`

Resolve up to 100 folder owners in one request. The body takes `addresses`: an array of
1–100 Stellar addresses (`G...` or `C...`). Duplicates are removed before the lookup, and
all owners are resolved with a single SQL query. The response is a map keyed by address;
owners without a folder map to `null`.

```bash
curl -X POST localhost:3000/folders/lookup \
  -H 'content-type: application/json' \
  -d '{"addresses":["GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM","GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"]}'
```

```json
{
  "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM": {
    "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
    "name": "smoke-1794262900.folder",
    "templateId": 1,
    "claimedAt": "2026-11-09T22:22:27.000Z",
    "updatedAt": "2026-11-09T22:23:07.000Z"
  },
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5": null
}
```

Errors: `400` when `addresses` is missing, empty, longer than 100, or contains invalid
entries. Every invalid entry is reported individually in `details`:

```json
{
  "error": "Invalid Stellar address",
  "details": [{ "index": 1, "address": "not-an-address", "message": "Invalid Stellar address" }],
  "requestId": "…"
}
```

## `POST /portfolios/lookup`

Same contract as [`POST /folders/lookup`](#post-folderslookup), returning portfolios keyed
by owner address with `null` for owners without a minted portfolio.

```bash
curl -X POST localhost:3000/portfolios/lookup \
  -H 'content-type: application/json' \
  -d '{"addresses":["GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM"]}'
```

```json
{
  "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM": {
    "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
    "templateId": 1,
    "ipfsCid": "bafkreifwfa7v77kn2om36djjtqiwqykldpady3ytsfbqkqgcrfilhjqtnu",
    "mintedAt": "2026-11-09T22:23:07.000Z",
    "updatedAt": "2026-11-09T22:23:52.000Z"
  }
}
```

Errors: `400` as above.

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

## `GET /nft/:tokenId/metadata`

ERC-721-style metadata document for a minted portfolio NFT, suitable for wallets and
marketplaces.

**Token identifier convention.** The Folder contract does not mint a separate numeric
token id: a portfolio is keyed by its owner address (`port_mint` / `port_upd` carry
`owner`, `template_id` and `ipfs_cid`). The token id is therefore the owner's Stellar
strkey (`G…` account or `C…` contract, 56 characters), the same value accepted by
`GET /portfolios/:address`.

The document is versioned by its `attributes` (`Metadata Version` = `1`) and served with
`Cache-Control: public, max-age=60`. `image` is the portfolio's IPFS CID resolved through
`IPFS_GATEWAY`; `external_url` is built from `FRONTEND_BASE_URL`.

```json
{
  "name": "D-Indexer Portfolio #GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ",
  "description": "Portfolio NFT owned by GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ, built from template 1.",
  "image": "https://ipfs.io/ipfs/bafkreiejxg6d3gqvi3737mcwxkv4u7gismaraxgv5zfoqtfuc3nbdgve7i",
  "external_url": "http://localhost:5173/portfolio/GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ",
  "attributes": [
    { "trait_type": "Owner", "value": "GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ" },
    { "trait_type": "Template", "value": 1 },
    { "trait_type": "IPFS CID", "value": "bafkreiejxg6d3gqvi3737mcwxkv4u7gismaraxgv5zfoqtfuc3nbdgve7i" },
    { "trait_type": "Minted At", "value": "2026-11-09T22:14:42.000Z" },
    { "trait_type": "Metadata Version", "value": 1 }
  ]
}
```

Errors: `400` invalid token id, `404` `Token not found`. The endpoint never returns a
partial document: if the portfolio is not indexed yet, it is a `404`.

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
