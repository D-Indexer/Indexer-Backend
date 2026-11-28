# API

Base URL locally: `http://localhost:3000`. All responses are JSON. Examples are real
responses from the local stack indexing the testnet contract.

| Method | Path                                                              | Purpose                               |
| ------ | ----------------------------------------------------------------- | ------------------------------------- |
| `GET`  | [`/`](#get-)                                                      | Service banner                        |
| `GET`  | [`/health`](#get-health)                                          | API + database health, indexer status |
| `GET`  | [`/folders/:address`](#get-foldersaddress)                        | Folder claimed by an address          |
| `GET`  | [`/folders/name/:name`](#get-foldersnamename)                     | Folder by name                        |
| `GET`  | [`/portfolios/:address`](#get-portfoliosaddress)                  | Portfolio NFT minted by an address    |
| `GET`  | [`/portfolios/:address/versions`](#get-portfoliosaddressversions) | Portfolio version history             |
| `GET`  | [`/portfolios/by-cid/:cid`](#get-portfoliosby-cidcid)             | Portfolios referencing a CID          |
| `GET`  | [`/templates`](#get-templates)                                    | All registered templates              |
| `GET`  | [`/templates/:id`](#get-templatesid)                              | One template                          |
| `GET`  | [`/templates/:id/portfolios`](#get-templatesidportfolios)         | Portfolios using a template           |
| `GET`  | [`/templates/:id/versions`](#get-templatesidversions)             | Template metadata history             |
| `GET`  | [`/creators/:address`](#get-creatorsaddress)                      | Template creator stats                |
| `GET`  | [`/creators/:address/templates`](#get-creatorsaddresstemplates)   | Templates registered by a creator     |
| `GET`  | [`/stats`](#get-stats)                                            | Activity totals                       |
| `GET`  | [`/stats/daily`](#get-statsdaily)                                 | Daily activity time series            |
| `POST` | [`/upload`](#post-upload)                                         | Add and pin a file on IPFS            |
| `GET`  | [`/.well-known/stellar.toml`](#get-well-knownstellartoml)         | SEP-1 stellar.toml                    |
| `GET`  | [`/federation`](#get-federation)                                  | SEP-2 federation lookup               |

## API keys

Read endpoints (`/folders`, `/portfolios`, `/templates`, `/creators`, `/stats`) work
anonymously. Integrators such as explorers and wallets can be issued an API key so the
operator can identify their traffic, contact them, and give them their own monthly quota.
Send it as a bearer token:

```bash
curl -H "Authorization: Bearer fk_…" localhost:3000/templates
```

| Request                               | Result                                                              |
| ------------------------------------- | ------------------------------------------------------------------- |
| No `Authorization` header             | Served anonymously, as before                                       |
| Valid key                             | Served; the request counts toward the key's usage                   |
| Header not of the form `Bearer <key>` | `401` `Malformed Authorization header: expected "Bearer <API key>"` |
| Token that isn't shaped like a key    | `401` `Malformed API key`                                           |
| Unknown key                           | `401` `Invalid API key`                                             |
| Revoked key                           | `401` `API key has been revoked`                                    |
| Key over its monthly quota            | `429` (see below), with `Retry-After` in seconds                    |

A key that is sent but invalid is rejected rather than served anonymously, so an
integrator notices at once when their key stops working. Revocation takes effect within
30 seconds (the API caches key lookups for that long).

Quotas are requests per calendar month (UTC). Over quota the response is:

```json
{
  "error": "Monthly quota of 100000 requests exceeded for this API key; it resets at 2026-12-01T00:00:00.000Z",
  "requestId": "0b6f4c2e-5d1a-4c55-9a43-3b2a9f0e8d11"
}
```

Usage is counted in memory per key and day and written to `api_key_usage` every 10
seconds, so quota enforcement is approximate across several API replicas and a crash can
lose up to one interval's counts.

### Managing keys

Requires `DATABASE_URL` and `API_KEY_HMAC_SECRET` (see
[configuration](configuration.md#api-keys)); with the secret unset, API keys are disabled.

```bash
npm run keys -- create --name "Explorer Inc" --contact ops@explorer.example [--quota 100000]
npm run keys -- list
npm run keys -- revoke <id>
```

`create` prints the key once. Only an HMAC-SHA256 of it under `API_KEY_HMAC_SECRET` is
stored, and the key is never logged, so a lost key can't be recovered: revoke it and
create a new one.

## Moderation

On-chain data can't be removed, but the API can choose what it promotes. Entries
(folders and portfolios) can be marked `hidden` or `flagged` by an operator. Moderation
state lives in its own `moderation` table, keyed by entity type and key, so re-indexing
or replaying events never overwrites it.

- **Listings, search and stats** never include `hidden` entries. `flagged` entries stay
  visible but are marked so clients can de-emphasize them.
- **Direct lookups** (`/folders/:address`, `/folders/name/:name`, `/portfolios/:address`)
  still return the data, with a `moderation` block. Hidden entries are **not** turned
  into `451`; the data is public on-chain and the API only declines to promote it.

```json
{
  "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
  "name": "smoke-1794262900.folder",
  "templateId": 1,
  "claimedAt": "2026-11-09T22:22:27.000Z",
  "updatedAt": "2026-11-09T22:23:07.000Z",
  "moderation": { "hidden": true }
}
```

`moderation` is omitted for entries with no active moderation record. For `flagged`
entries it is `{ "hidden": false, "flagged": true, "reason": "…" }`.

### CLI

Moderation is managed with `src/cli/moderation.ts`. Every action requires an actor and
a reason and is appended to the audit trail (see below).

```bash
# Hide / flag an entry
npm run moderation -- hide folder GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM \
  --actor alice --reason "impersonation"
npm run moderation -- flag portfolio GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM \
  --actor alice --reason "offensive content"

# Undo a moderation action
npm run moderation -- unhide folder GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM \
  --actor alice --reason "appeal accepted"

# Inspect
npm run moderation -- list
npm run moderation -- history folder GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM
```

Entity types are `folder` (keyed by owner address) and `portfolio` (keyed by owner
address). States are `hidden` and `flagged`; `unhide` clears the record.

### Audit trail

Each moderation action is recorded with the entity type and key, the resulting state,
the actor, the reason and a timestamp. Records are append-only: changing or clearing a
moderation state adds a new row rather than editing the previous one, so
`moderation history` shows the full sequence of actions for an entry.

## Errors

Every error has the same shape:

```json
{ "error": "Invalid Stellar address", "requestId": "0b6f4c2e-5d1a-4c55-9a43-3b2a9f0e8d11" }
```

| Status | When                                                                       | `error` examples                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid path parameter, query parameter or upload                          | `Invalid Stellar address`, `Template ID must be a number`, `Template ID must be at most 4294967295`, `Folder name contains unsupported characters`, `Invalid CID`, `atLedger must be a number`, `atLedger is before the earliest indexed ledger`, `atLedger is after the last indexed ledger`, `Invalid cursor`, `No file provided`, `Unsupported file type`, `File content does not match its declared type`, `File exceeds 10 MB limit` |
| `401`  | `Authorization` header sent with a malformed, unknown or revoked API key   | `Malformed API key`, `Invalid API key`, `API key has been revoked`                                                                                                                                                                                                                                                                                                                                                                        |
| `404`  | Resource not indexed, or unknown route                                     | `Folder not found`, `Portfolio not found`, `Template not found`, `Route not found` (also includes `path`)                                                                                                                                                                                                                                                                                                                                 |
| `410`  | `/changes` only: cursor expired or unknown                                 | `Cursor expired` (body includes `resync: true` and instructions)                                                                                                                                                                                                                                                                                                                                                                          |
| `429`  | `/stream`: too many concurrent connections; API key over its monthly quota | `Too many stream connections`, `Monthly quota of … requests exceeded for this API key; …`                                                                                                                                                                                                                                                                                                                                                 |
| `502`  | IPFS node unreachable or returned an error                                 | `IPFS node unreachable`, `IPFS add failed with status 500`                                                                                                                                                                                                                                                                                                                                                                                |
| `503`  | `/health` only: database unreachable; uploads: concurrency saturated       | see below; uploads include a `Retry-After` header                                                                                                                                                                                                                                                                                                                                                                                         |
| `504`  | IPFS node timed out (`IPFS_TIMEOUT_MS`)                                    | `IPFS node timed out`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `500`  | Anything unexpected; details are logged, not returned                      | `Internal server error`                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Request IDs

Every response carries an `x-request-id` header, also echoed as `requestId` in error bodies
and server logs. Send your own `x-request-id` (1–128 characters of `A-Z a-z 0-9 . _ : -`)
to correlate; anything else is replaced with a UUID.

### Validation rules

- `:address` is a Stellar strkey: `G…` (account) or `C…` (contract), 56 characters.
- `:name` is 1–64 characters of `A-Z a-z 0-9 . _ -`. On-chain names end in `.folder`.
- `:id` is a non-negative integer up to `4294967295` (the contract stores `u32`).
- `:cid` is a valid CIDv0 (`Qm…`) or CIDv1 (`bafy…`) string. Both forms of the same
  content are equivalent: lookups normalise the input to CIDv1 before matching.
- `atLedger` is a non-negative integer ledger sequence. It must fall within the
  indexed range (`earliest indexed ledger` ≤ `atLedger` ≤ `last_ledger`); otherwise
  the request is rejected with `400`.

### Point-in-time reads (`?atLedger=`)

`GET /folders/:address`, `GET /folders/name/:name`, `GET /portfolios/:address`,
`GET /templates/:id` and `GET /templates` accept an optional `atLedger` query
parameter. When present, the response reflects the state as of the end of that
ledger instead of the current state. The response shape is unchanged; timestamps
are still ledger close times.

```bash
curl "localhost:3000/portfolios/GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM?atLedger=5654400"
```

Errors: `400` `atLedger must be a number`, `atLedger is before the earliest indexed
ledger`, `atLedger is after the last indexed ledger`.

### Pagination

The `…/versions` endpoints are keyset paginated. Pass `limit` (1–100, default 20)
and, to fetch the next page, the `cursor` value returned by the previous response.
Pages are ordered newest version first. An invalid `cursor` returns `400`
`Invalid cursor`.

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
  "updatedAt": "2026-11-09T22:23:07.000Z",
  "archival": { "liveUntilLedger": 5658123, "archived": false }
}
```

Errors: `400` invalid address, `404` `Folder not found`. Hidden entries are still
returned, with `moderation: { hidden: true }` (see [moderation](#moderation)).

## `GET /folders/name/:name`

Same response as above, looked up by folder name.

```bash
curl localhost:3000/folders/name/smoke-1794262900.folder
```

Errors: `400` invalid name, `404` `Folder not found`. Hidden entries are still returned,
with `moderation: { hidden: true }`.

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
  "updatedAt": "2026-11-09T22:23:52.000Z",
  "archival": { "liveUntilLedger": 5658123, "archived": false }
}
```

Errors: `400` invalid address, `404` `Portfolio not found`. Hidden entries are still
returned, with `moderation: { hidden: true }`.

## `GET /portfolios/:address/versions`

Version history of the portfolio owned by `address`, newest first. A new version is
recorded on every `port_mint`, `port_upd` and `tmpl_set` event. `version` numbers are
dense and stable: replaying the same ledger range produces identical history.

```bash
curl "localhost:3000/portfolios/GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM/versions?limit=2"
```

```json
{
  "versions": [
    {
      "version": 2,
      "ipfsCid": "bafkreifwfa7v77kn2om36djjtqiwqykldpady3ytsfbqkqgcrfilhjqtnu",
      "templateId": 1,
      "ledger": 5654521,
      "at": "2026-11-09T22:23:52.000Z"
    },
    {
      "version": 1,
      "ipfsCid": "bafkreiacuprjr4kth5rfldcy4tdq5xfltl22kdlc3es72u4qsqqcb6ypxa",
      "templateId": 1,
      "ledger": 5654400,
      "at": "2026-11-09T22:23:07.000Z"
    }
  ],
  "nextCursor": "2"
}
```

`nextCursor` is `null` on the last page.

Errors: `400` invalid address or cursor, `404` `Portfolio not found`.

## `GET /portfolios/by-cid/:cid`

Reverse lookup: portfolios whose current or historical `ipfsCid` matches `cid`.
CIDv0 and CIDv1 inputs for the same content return the same results. Lookup is
index-backed.

```bash
curl "localhost:3000/portfolios/by-cid/bafkreifwfa7v77kn2om36djjtqiwqykldpady3ytsfbqkqgcrfilhjqtnu"
```

```json
{
  "cid": "bafkreifwfa7v77kn2om36djjtqiwqykldpady3ytsfbqkqgcrfilhjqtnu",
  "current": [
    {
      "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
      "templateId": 1,
      "updatedAt": "2026-11-09T22:23:52.000Z"
    }
  ],
  "historical": [
    {
      "owner": "GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ",
      "version": 1,
      "at": "2026-11-09T22:14:42.000Z"
    }
  ]
}
```

`historical` lists versions that referenced the CID but are no longer current. Pass
`includeHistorical=false` to omit it (default `true`).

Errors: `400` `Invalid CID`.

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

| Query  | Values          | Default |
| ------ | --------------- | ------- |
| `sort` | `id`, `popular` | `id`    |

`sort=popular` orders by `usageCount` descending, then id. Any other value returns `400`
`sort must be 'id' or 'popular'`.

`usageCount` is the number of minted portfolios currently using the template. The
indexer maintains it as a counter in the same transaction that applies `port_mint` and
`tmpl_set` (a `tmpl_set` on a minted portfolio moves it from the old template to the
new one), so reading it never aggregates over portfolios.

```json
[
  {
    "id": 1,
    "metadataUri": "ipfs://bafkreiejxg6d3gqvi3737mcwxkv4u7gismaraxgv5zfoqtfuc3nbdgve7i",
    "creator": "GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ",
    "registeredAt": "2026-11-09T22:14:42.000Z",
    "usageCount": 12,
    "archival": { "liveUntilLedger": 5658123, "archived": false }
  }
]
```

## `GET /templates/:id`

One template, same shape as a list item.

Errors: `400` invalid id, `404` `Template not found`.

## `GET /templates/:id/portfolios`

Portfolios currently using the template, most recently updated first (ties broken by
owner). Keyset paginated (see [Pagination](#pagination)): `limit` 1–100, default 20.

```bash
curl "localhost:3000/templates/1/portfolios?limit=2"
```

```json
{
  "portfolios": [
    {
      "owner": "GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM",
      "templateId": 1,
      "ipfsCid": "bafkreifwfa7v77kn2om36djjtqiwqykldpady3ytsfbqkqgcrfilhjqtnu",
      "mintedAt": "2026-11-09T22:23:07.000Z",
      "updatedAt": "2026-11-09T22:23:52.000Z"
    }
  ],
  "nextCursor": null
}
```

Errors: `400` invalid id, `limit` or cursor; `404` `Template not found`.

## `GET /creators/:address`

Aggregate stats for a template creator: how many templates `tmpl_reg` attributes to the
address and their combined `usageCount`. Creators aren't registered anywhere, so an
address with no templates returns zeros, not `404`.

```json
{
  "address": "GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ",
  "templateCount": 2,
  "totalUsage": 14
}
```

Errors: `400` `Invalid Stellar address`.

## `GET /creators/:address/templates`

Templates registered by `address`, oldest registration first (ties broken by id), in the
same shape as [`GET /templates`](#get-templates). Keyset paginated (see
[Pagination](#pagination)): `limit` 1–100, default 20. An address with no templates
returns `{ "templates": [], "nextCursor": null }`, not `404`.

```json
{
  "templates": [
    {
      "id": 1,
      "metadataUri": "ipfs://bafkreiejxg6d3gqvi3737mcwxkv4u7gismaraxgv5zfoqtfuc3nbdgve7i",
      "creator": "GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ",
      "registeredAt": "2026-11-09T22:14:42.000Z",
      "usageCount": 12
    }
  ],
  "nextCursor": null
}
```

Templates registered by older contract versions, whose `tmpl_reg` event carried no
creator, are indexed with `"creator": null`. They are not attributable to any address and
never appear under `/creators`.

Errors: `400` `Invalid Stellar address`, invalid `limit` or cursor.

## `GET /stats`

All-time totals:

```json
{ "foldersClaimed": 412, "portfoliosMinted": 230, "portfolioUpdates": 1871, "templatesRegistered": 9 }
```

| Field                 | Counts                                                     |
| --------------------- | ---------------------------------------------------------- |
| `foldersClaimed`      | Owners' first `folder_cl` (a re-claim doesn't count again) |
| `portfoliosMinted`    | Owners' first `port_mint` (a re-mint doesn't count again)  |
| `portfolioUpdates`    | Every `port_upd`                                           |
| `templatesRegistered` | Templates' first `tmpl_reg` (re-registration doesn't)      |

Only applied events count; rejected events never do. The indexer maintains these counters
per day as it stores events, so requests never aggregate over the event tables.

## `GET /stats/daily`

The same counters per UTC calendar day of ledger close, for every day in the range
(days without activity are returned with zeros).

| Query  | Format       | Default                              |
| ------ | ------------ | ------------------------------------ |
| `from` | `YYYY-MM-DD` | 29 days before `to`                  |
| `to`   | `YYYY-MM-DD` | today (UTC), or 29 days after `from` |

Both ends are inclusive; the range may cover at most 366 days.

```bash
curl "localhost:3000/stats/daily?from=2026-11-09&to=2026-11-10"
```

```json
{
  "from": "2026-11-09",
  "to": "2026-11-10",
  "days": [
    {
      "day": "2026-11-09",
      "foldersClaimed": 3,
      "portfoliosMinted": 1,
      "portfolioUpdates": 4,
      "templatesRegistered": 1
    },
    {
      "day": "2026-11-10",
      "foldersClaimed": 0,
      "portfoliosMinted": 0,
      "portfolioUpdates": 0,
      "templatesRegistered": 0
    }
  ]
}
```

Errors: `400` `from must be a date in YYYY-MM-DD format` (same for `to`), `from must not be
after to`, `Date range must be at most 366 days`.

## Archival

Soroban persistent storage entries have a TTL and are archived when it expires unless it
is extended. Folder claims, template registrations and portfolios are all stored this way,
and archival is not announced by contract events, so the indexer periodically queries
`getLedgerEntries` for the storage keys backing each entity and records their TTL.

Every folder, portfolio and template response includes an `archival` object:

| Field             | Meaning                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `liveUntilLedger` | The ledger at which the entity's storage entry expires, or `null` if it hasn't been checked yet. |
| `archived`        | `true` when the entry is no longer live (its TTL has passed or the key is missing on-chain).     |

An archived entry must be restored (via `RestoreFootprint`) before the contract can read
or write it, so treat `archived: true` as "not currently usable on-chain" even though the
read model still returns the last indexed data. The indexer prioritises recently active
entities and batches `getLedgerEntries` calls to keep RPC usage bounded; see
[operations](operations.md#status-cli) for the soon-to-expire list in the status CLI.

## `POST /upload`

Multipart upload with a single field named `file`. The file is added to the configured
Kubo node with `pin=true` and its CID (v1) returned.

- Allowed types: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.
- The declared type must match the file's leading bytes.
- Maximum size: 10 MB. One file per request.
- Images are checked from their headers without full decoding. Images above
  `UPLOAD_MAX_IMAGE_PIXELS` (default 40 MP) or with a side longer than
  `UPLOAD_MAX_IMAGE_SIDE` are rejected with `400 Image dimensions exceed limit`.
- PDFs are parsed (not rendered) and rejected with `400` if they contain active
  content: JavaScript (`/JS`, `/JavaScript`), auto-actions (`/OpenAction`, `/AA`),
  launch actions (`/Launch`), embedded files (`/EmbeddedFile`) or rich media
  (`/RichMedia`). The `error` message names the reason, e.g.
  `PDF contains active content: JavaScript`. Encrypted PDFs are rejected with
  `400 Encrypted PDF not allowed` because their content can't be inspected.
  Parsing is time- and memory-bounded; a parser failure is treated as a rejection.
- At most `UPLOAD_MAX_CONCURRENT` uploads are buffered at once. When saturated,
  the request is rejected immediately with `503` and a `Retry-After` header
  (seconds) without reading the body.

```bash
curl -F "file=@avatar.png;type=image/png" localhost:3000/upload
# or: examples/curl/upload.sh avatar.png
```

```json
{ "cid": "bafkreiacuprjr4kth5rfldcy4tdq5xfltl22kdlc3es72u4qsqqcb6ypxa" }
```

Errors: `400` (no file, type, size, content mismatch, image dimensions, PDF active
content, encrypted PDF), `502` / `504` (IPFS), `503` (concurrency saturated, see
`Retry-After`).

The endpoint is unauthenticated and not rate limited yet; don't expose it publicly
without a proxy that enforces limits.

## RPC usage limits

TTL tracking is the only part of the indexer that calls `getLedgerEntries`; event polling
uses a separate cursor. To stay within provider quotas:

- Keys are queried in batches (`TTL_BATCH_SIZE`, default 50) rather than one call per entity.
- Polls run on an interval (`TTL_POLL_INTERVAL_MS`, default 60000) and are skipped while a
  previous poll is still in flight.
- Recently active entities are checked first; entities whose TTL is far from expiry are
  refreshed less often.
- If the RPC returns a rate-limit error the poll backs off and retries on the next interval.
