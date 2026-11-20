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
| `GET`  | [`/stream`](#get-stream)                         | Server-Sent Events of indexed changes |
| `GET`  | [`/changes`](#get-changes)                       | Incremental read-model changes feed   |
| `POST` | [`/upload`](#post-upload)                        | Add and pin a file on IPFS            |

## Errors

Every error has the same shape:

```json
{ "error": "Invalid Stellar address", "requestId": "0b6f4c2e-5d1a-4c55-9a43-3b2a9f0e8d11" }
```

| Status | When                                                  | `error` examples                                                                                                                                                                                                                                                             |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid path parameter or upload                      | `Invalid Stellar address`, `Template ID must be a number`, `Template ID must be at most 4294967295`, `Folder name contains unsupported characters`, `No file provided`, `Unsupported file type`, `File content does not match its declared type`, `File exceeds 10 MB limit`, `Invalid cursor`, `Invalid limit`, `Invalid topics` |
| `404`  | Resource not indexed, or unknown route                | `Folder not found`, `Portfolio not found`, `Template not found`, `Route not found` (also includes `path`)                                                                                                                                                                    |
| `410`  | `/changes` only: cursor expired or unknown            | `Cursor expired` (body includes `resync: true` and instructions)                                                                                                                                                                                                             |
| `429`  | `/stream` only: too many concurrent connections       | `Too many stream connections`                                                                                                                                                                                                                                                |
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

## `GET /stream`

Server-Sent Events (`text/event-stream`) stream of indexed changes, fed by the
Postgres `NOTIFY` listener. Use it to update a portfolio page or a "recent mints"
list live, or to learn when your own transaction has been indexed.

### Query parameters

| Name     | Required | Description                                                                                                 |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `topics` | no       | Comma-separated list of `folder`, `portfolio`, `template`. Omit to receive all topics.                      |
| `owner`  | no       | Stellar address (`G…`/`C…`). Only events affecting this owner are delivered.                                |

```bash
curl -N "localhost:3000/stream?topics=folder,portfolio&owner=GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM"
```

### Message format

Each message is a JSON payload in `data:` with an `id:` equal to the opaque event
cursor (the same cursor space as [`/changes`](#get-changes)). The `event:` field is
the topic.

```
id: 00000000000000000042
event: portfolio
data: {"entity":"portfolio","key":"GAPAMT…2CM","op":"upsert","data":{"owner":"GAPAMT…2CM","templateId":1,"ipfsCid":"bafkrei…","mintedAt":"2026-11-09T22:23:07.000Z","updatedAt":"2026-11-09T22:23:52.000Z"},"cursor":"00000000000000000042"}

```

A comment line `: heartbeat` is sent every 15 s so idle connections and proxies stay
open; ignore lines starting with `:`.

### Resuming with `Last-Event-ID`

Reconnect with the `Last-Event-ID` header (or `?lastEventId=`) set to the last `id:`
you received. Missed events are replayed from `contract_events` before the live
stream resumes, so each event is delivered exactly once. Without it, only events
committed after the connection is established are sent.

### Limits and shutdown

- Concurrent connections are limited per client IP; exceeding the limit returns
  `429 Too many stream connections` before the stream starts.
- On graceful shutdown the server sends a final `event: close` and ends the stream;
  reconnect with `Last-Event-ID` to resume.

### Proxies

The route sets `X-Accel-Buffering: no` and `Cache-Control: no-cache`, and compression
is disabled for it. If you put another proxy in front, disable response buffering
there too (e.g. nginx `proxy_buffering off;`), otherwise events will arrive in bursts.

## `GET /changes`

Incremental, entity-level changes feed for mirroring folders, portfolios and
templates locally. Apply the feed from an empty state to reproduce the current read
model exactly.

### Query parameters

| Name    | Required | Description                                                                                       |
| ------- | -------- | ------------------------------------------------------------------------------------------------- |
| `since` | no       | Opaque cursor from a previous response. Omit to start from the beginning of indexed history.      |
| `limit` | no       | Page size, 1–1000 (default 100).                                                                  |

```bash
curl "localhost:3000/changes?since=00000000000000000000&limit=2"
```

```json
{
  "changes": [
    {
      "entity": "folder",
      "key": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
      "op": "upsert",
      "data": {
        "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
        "name": "smoke-1794262900.folder",
        "templateId": null,
        "claimedAt": "2026-11-09T22:22:27.000Z",
        "updatedAt": "2026-11-09T22:22:27.000Z"
      },
      "cursor": "00000000000000000001"
    },
    {
      "entity": "portfolio",
      "key": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
      "op": "upsert",
      "data": {
        "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
        "templateId": 1,
        "ipfsCid": "bafkreifwfa7v77kn2om36djjtqiwqykldpady3ytsfbqkqgcrfilhjqtnu",
        "mintedAt": "2026-11-09T22:23:07.000Z",
        "updatedAt": "2026-11-09T22:23:07.000Z"
      },
      "cursor": "00000000000000000002"
    }
  ],
  "next": "00000000000000000002",
  "hasMore": false
}
```

- `entity` is `folder`, `portfolio` or `template`; `key` is the entity's primary key
  (owner address or template id).
- `op` is `upsert` or `delete`. `data` is `null` for deletes.
- Changes are returned in commit order. Paging is stable under concurrent indexing:
  pass the returned `next` cursor as `since` to get the following page. `hasMore` is
  `true` when more changes exist after `next`.
- Cursors are opaque and stable; don't parse or construct them.

### Expired cursors

If a cursor is malformed or older than the retained history, the endpoint returns
`410 Gone`:

```json
{
  "error": "Cursor expired",
  "resync": true,
  "message": "Discard your local state and re-fetch from /changes without `since`.",
  "requestId": "…"
}
```

On `410`, drop local state and restart from the beginning (or re-download the REST
resources).

## Webhooks

Integrators (wallets, Discord bots, analytics) can subscribe to signed push
deliveries of indexed events instead of polling. Subscriptions are managed with the
admin CLI (they are not exposed over HTTP):

```bash
# add a subscription: URL, topics, optional owner filter
npm run cli -- webhooks add \
  --url https://example.com/hooks/dindexer \
  --topics folder,portfolio \
  --owner GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM \
  --secret "$WEBHOOK_SECRET"

npm run cli -- webhooks list
npm run cli -- webhooks disable <id>
npm run cli -- webhooks enable <id>
npm run cli -- webhooks remove <id>
npm run cli -- webhooks deliveries <id>   # recent delivery attempts
```

- Each delivery is a `POST` with a JSON body containing `id` (event id, use it for
  de-duplication), `topic`, `entity`, `key`, `op`, `data` and `cursor`.
- Deliveries are retried with backoff; a subscription is disabled automatically after
  a configured number of consecutive failures. Delivery attempts are recorded and
  visible via `webhooks deliveries`.
- Receiver URLs that resolve to private, loopback or link-local ranges
  (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`,
  `::1`, `fc00::/7`, `fe80::/10`, …) are refused. The check is done at delivery time
  on the resolved IP, and the connection is made to that resolved IP, so DNS
  rebinding cannot redirect a delivery to an internal host.

### Signature

Each request carries:

| Header                  | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| `X-DIndexer-Timestamp`  | Unix time in seconds when the delivery was signed           |
| `X-DIndexer-Signature`  | `sha256=<hex HMAC-SHA256 of "timestamp.body">`              |
| `X-DIndexer-Event-Id`   | Event id (same as `id` in the body), for de-duplication     |

The signed string is the timestamp, a literal `.`, then the raw request body bytes:
`HMAC_SHA256(secret, timestamp + "." + body)`. Verify against the raw body before
parsing JSON, and reject timestamps outside a small tolerance (e.g. 5 minutes) to
prevent replays.

### Verification snippet (Node.js)

```js
const crypto = require('node:crypto');

function verifyWebhook(secret, headers, rawBody, toleranceSeconds = 300) {
  const timestamp = headers['x-dindexer-timestamp'];
  const signature = headers['x-dindexer-signature'];
  if (!timestamp || !signature) return false;

  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Express: keep the raw body for verification
app.post('/hooks/dindexer', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyWebhook(process.env.WEBHOOK_SECRET, req.headers, req.body)) {
    return res.status(401).end();
  }
  const event = JSON.parse(req.body.toString('utf8'));
  // de-duplicate on event.id, then handle event
  res.status(204).end();
});
```

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
