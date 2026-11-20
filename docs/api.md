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
| `POST` | [`/upload/resumable`](#post-uploadresumable)     | Create a resumable upload (tus 1.0)   |
| `PATCH`| [`/upload/resumable/:id`](#patch-uploadresumableid) | Append a chunk to a resumable upload |
| `HEAD` | [`/upload/resumable/:id`](#head-uploadresumableid)  | Query the stored offset of an upload |

## Errors

Every error has the same shape:

```json
{ "error": "Invalid Stellar address", "requestId": "0b6f4c2e-5d1a-4c55-9a43-3b2a9f0e8d11" }
```

| Status | When                                                  | `error` examples                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid path parameter or upload                      | `Invalid Stellar address`, `Template ID must be a number`, `Template ID must be at most 4294967295`, `Folder name contains unsupported characters`, `No file provided`, `Unsupported file type`, `File content does not match its declared type`, `File exceeds 10 MB limit`, `Invalid upload ID`, `Upload offset mismatch`, `Upload already completed`, `Upload expired` |
| `404`  | Resource not indexed, or unknown route                | `Folder not found`, `Portfolio not found`, `Template not found`, `Upload not found`, `Route not found` (also includes `path`)                                                                                                                                                 |
| `409`  | Resumable upload offset conflict                      | `Upload offset mismatch`                                                                                                                                                                                                                                                     |
| `410`  | Resumable upload expired or already finalised         | `Upload expired`, `Upload already completed`                                                                                                                                                                                                                                 |
| `451`  | Content removed by a takedown (denylisted CID)        | `Content unavailable for legal reasons`                                                                                                                                                                                                                                      |
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

If the portfolio's `ipfsCid` has been denylisted (see [Takedowns](#takedowns-and-the-cid-denylist)),
the response still includes the CID but adds `"contentRemoved": true`:

```json
{
  "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
  "templateId": 1,
  "ipfsCid": "bafkreifwfa7v77kn2om36djjtqiwqykldpady3ytsfbqkqgcrfilhjqtnu",
  "contentRemoved": true,
  "mintedAt": "2026-11-09T22:23:07.000Z",
  "updatedAt": "2026-11-09T22:23:52.000Z"
}
```

The flag is only present when `true`. The CID is never rewritten: the on-chain reference
cannot be removed, only the content behind it is no longer served or pinned.

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

Errors: `400` (no file, type, size, content mismatch), `451` (content denylisted),
`502` / `504` (IPFS).

The client-supplied filename is never forwarded to Kubo. It is sanitised server-side
(path separators, control characters, NUL/CR/LF, RTL overrides and over-long names are
neutralised) and replaced with a server-chosen name derived from the sniffed type
(`upload.<ext>`). Logs only ever contain the sanitised name. The returned CID is
unaffected by the filename.

If the uploaded bytes hash to a denylisted CID, the upload is rejected with `451` and
nothing is pinned.

The endpoint is unauthenticated and not rate limited yet; don't expose it publicly
without a proxy that enforces limits.

## `POST /upload/resumable`

Creates a resumable upload using the [tus 1.0](https://tus.io/protocols/resumable-upload)
creation extension. Use this for large files on unreliable connections: an interrupted
upload resumes from the last acknowledged offset instead of restarting.

Request headers:

| Header             | Required | Meaning                                          |
| ------------------ | -------- | ------------------------------------------------ |
| `Upload-Length`    | yes      | Total size in bytes (max 10 MB)                  |
| `Upload-Metadata`  | no       | tus metadata, e.g. `filename <base64>,filetype <base64>` |
| `Tus-Resumable`    | yes      | Must be `1.0.0`                                  |

```bash
curl -i -X POST localhost:3000/upload/resumable \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: 7340032" \
  -H "Upload-Metadata: filetype $(printf 'application/pdf' | base64)"
```

```http
HTTP/1.1 201 Created
Location: /upload/resumable/9f1c2b7e-3a4d-4e6f-8b21-5c0d9e7a1f42
Tus-Resumable: 1.0.0
Upload-Expires: Wed, 10 Dec 2026 08:00:00 GMT
```

Chunks are written to disk (never held in memory) under a partial-upload directory.
An upload that receives no data for `UPLOAD_TTL_MS` is deleted by a scheduled cleanup
job; `Upload-Expires` reports the deadline.

Errors: `400` (missing/invalid `Upload-Length`, unsupported type), `451` (content
denylisted), `503` (storage unavailable).

## `PATCH /upload/resumable/:id`

Appends a chunk at the current offset.

| Header             | Required | Meaning                                     |
| ------------------ | -------- | ------------------------------------------- |
| `Tus-Resumable`    | yes      | Must be `1.0.0`                             |
| `Upload-Offset`    | yes      | Byte offset this chunk starts at            |
| `Content-Type`     | yes      | `application/offset+octet-stream`           |
| `Content-Length`   | yes      | Chunk size in bytes                         |

```bash
curl -i -X PATCH localhost:3000/upload/resumable/9f1c2b7e-3a4d-4e6f-8b21-5c0d9e7a1f42 \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 4404019" \
  -H "Content-Type: application/offset+octet-stream" \
  --data-binary @chunk.bin
```

```http
HTTP/1.1 204 No Content
Tus-Resumable: 1.0.0
Upload-Offset: 7340032
```

When the final chunk brings the stored size to `Upload-Length`, the assembled file runs
through the same validation pipeline as `POST /upload` (type sniffing, size, content
match, filename sanitisation), is pinned, and the CID is returned in the body:

```json
{ "cid": "bafkreiacuprjr4kth5rfldcy4tdq5xfltl22kdlc3es72u4qsqqcb6ypxa" }
```

The CID is identical to what a single-request `POST /upload` of the same bytes returns.

Errors: `400` (bad offset, invalid chunk), `404` `Upload not found`, `409` `Upload offset
mismatch` (send `HEAD` to resynchronise), `410` `Upload expired` / `Upload already
completed`, `451` (content denylisted), `502` / `504` (IPFS).

## `HEAD /upload/resumable/:id`

Returns the stored offset so an interrupted client can resume.

```bash
curl -I localhost:3000/upload/resumable/9f1c2b7e-3a4d-4e6f-8b21-5c0d9e7a1f42 \
  -H "Tus-Resumable: 1.0.0"
```

```http
HTTP/1.1 200 OK
Tus-Resumable: 1.0.0
Upload-Offset: 4404019
Upload-Length: 7340032
Upload-Expires: Wed, 10 Dec 2026 08:00:00 GMT
```

Errors: `404` `Upload not found`, `410` `Upload expired` / `Upload already completed`.

## Takedowns and the CID denylist

CIDs can be denylisted for legal or policy reasons (copyright, illegal content, personal
data published without consent). On-chain references cannot be removed, so the denylist
is enforced at every point where content is served or pinned:

- **Upload** — re-uploading content whose CID is denylisted is rejected with `451`.
- **Gateway proxy** — requests for a denylisted CID return `451 Unavailable For Legal
  Reasons`.
- **Reconciler** — denylisted CIDs are never re-pinned; if already pinned they are
  unpinned on the next cycle.
- **API responses** — resources referencing a denylisted CID include
  `"contentRemoved": true` (see [`GET /portfolios/:address`](#get-portfoliosaddress)).

Denylist entries are managed with the operator CLI (see
[operations](operations.md#cid-denylist)) and every change is recorded with a reason
category, reference, actor and timestamp. Lists can be shared in the community
double-hash format (`sha256(CID)`) without republishing the CIDs themselves.
