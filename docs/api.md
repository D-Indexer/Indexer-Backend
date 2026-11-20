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
| `GET`  | [`/templates`](#get-templates)                   | All registered templates              |
| `GET`  | [`/templates/:id`](#get-templatesid)             | One template                          |
| `POST` | [`/upload`](#post-upload)                        | Add and pin a file on IPFS            |
| `GET`  | [`/.well-known/stellar.toml`](#get-well-knownstellartoml) | SEP-1 stellar.toml          |
| `GET`  | [`/federation`](#get-federation)                 | SEP-2 federation lookup               |

## Errors

Every error has the same shape:

```json
{ "error": "Invalid Stellar address", "requestId": "0b6f4c2e-5d1a-4c55-9a43-3b2a9f0e8d11" }
```

| Status | When                                                  | `error` examples                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid path parameter, query parameter or upload     | `Invalid Stellar address`, `Template ID must be a number`, `Template ID must be at most 4294967295`, `Folder name contains unsupported characters`, `Invalid federation type`, `Invalid federation query`, `No file provided`, `Unsupported file type`, `File content does not match its declared type`, `File exceeds 10 MB limit` |
| `404`  | Resource not indexed, or unknown route                | `Folder not found`, `Portfolio not found`, `Template not found`, `Federation record not found`, `Route not found` (also includes `path`)                                                                                                                                    |
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
  "mintedAt": "2026-11-09T22:23:07.000Z",
  "updatedAt": "2026-11-09T22:23:52.000Z"
}
```

Errors: `400` invalid address, `404` `Portfolio not found`.

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

## `GET /.well-known/stellar.toml`

Serves the [SEP-1](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md)
`stellar.toml` that lets wallets discover the federation server. The document is built
from configuration (`STELLAR_TOML_*` / `FEDERATION_*` env vars, see
[configuration](configuration.md)); only fields that are configured are emitted, so the
output always validates against SEP-1 for the fields provided.

```bash
curl localhost:3000/.well-known/stellar.toml
```

```toml
FEDERATION_SERVER = "https://api.example.com/federation"

[DOCUMENTATION]
ORG_NAME = "Folder"
ORG_URL = "https://folder.example"
ORG_DESCRIPTION = "Human-readable names for Stellar accounts"
```

- `Content-Type: text/plain; charset=utf-8` (SEP-1 requires `text/plain`).
- `Access-Control-Allow-Origin: *` so browser-based wallets can fetch it.
- `Cache-Control: public, max-age=300`.

## `GET /federation`

[SEP-2](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0002.md)
federation endpoint. Two query types are supported:

| Query                    | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `type=name&q=<name>*<domain>` | Forward lookup: federation address → account |
| `type=id&q=<account>`    | Reverse lookup: account → federation address   |

### Forward lookup (`type=name`)

`q` must be a federation address of the form `<name>*<domain>`. The domain must match
`FEDERATION_DOMAIN` (case-insensitive); anything else is a `404`. The name part is
normalised before lookup (see [name normalisation](#name-normalisation)).

```bash
curl 'localhost:3000/federation?type=name&q=smoke-1794262900*folder.example'
```

```json
{
  "stellar_address": "smoke-1794262900*folder.example",
  "account_id": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM"
}
```

### Reverse lookup (`type=id`)

`q` must be a Stellar account strkey (`G…`). The response uses the folder's canonical
on-chain name (including the `.folder` suffix) as the federation name.

```bash
curl 'localhost:3000/federation?type=id&q=GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM'
```

```json
{
  "stellar_address": "smoke-1794262900.folder*folder.example",
  "account_id": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM"
}
```

### Errors

- `400` `Invalid federation type` when `type` is missing or not `name` / `id`.
- `400` `Invalid federation query` when `q` is missing, malformed, or (for `type=id`)
  not a valid `G…` account.
- `404` `Federation record not found` when no indexed folder matches, or the domain in
  a `type=name` query isn't the configured federation domain.

### Headers

- `Content-Type: application/json`.
- `Access-Control-Allow-Origin: *` (SEP-2 clients are often browser-based).
- `Cache-Control: public, max-age=60` on `200` responses.

### Name normalisation

Federation names are derived from on-chain folder names as follows:

1. Take the folder name as stored on-chain (e.g. `smoke-1794262900.folder`).
2. Strip the trailing `.folder` suffix to get the federation name
   (`smoke-1794262900`).
3. Lowercase the result. On-chain names are already restricted to `A-Z a-z 0-9 . _ -`,
   so no other characters need escaping.

Forward lookups apply the same normalisation to the `q` name part before matching, so
`Smoke-1794262900*<domain>` and `smoke-1794262900*<domain>` resolve to the same account.
Reverse lookups always return the canonical on-chain name (suffix included) so the
address round-trips through a forward lookup.
