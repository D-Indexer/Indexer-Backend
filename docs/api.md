# API Reference

D-Indexer-Backend exposes REST endpoints for Folder clients. All responses are JSON.

## Base URL

Local development defaults to:

```text
http://localhost:3000
```

## Health

### `GET /health`

Checks PostgreSQL reachability and returns the current indexer cursor.

Successful response:

```json
{
  "status": "ok",
  "db": "ok",
  "indexer": {
    "cursor": "12345"
  },
  "requestId": "..."
}
```

If PostgreSQL is unreachable, the endpoint returns `503`.

## Folders

### `GET /folders/:address`

Fetches a Folder by Stellar public key.

Invalid Stellar addresses return `400`.
Unknown folders return `404`.

### `GET /folders/name/:name`

Fetches a Folder by claimed Folder name.

Names must be 1-64 characters and contain only letters, numbers, `.`, `_`, or `-`.

### `GET /folders/:address/credentials`

Returns credentials linked to a Folder owner, ordered newest first.

## Templates

### `GET /templates`

Returns all non-deprecated templates ordered by ID.

### `GET /templates/:id`

Returns one template by numeric ID.

Invalid IDs return `400`.
Unknown templates return `404`.

## Uploads

### `POST /upload`

Pins a file to IPFS and returns the CID.

The request must be multipart form data with one field:

| Field | Required | Description |
| ----- | -------- | ----------- |
| `file` | yes | File to pin to IPFS |

Allowed MIME types:

- `image/jpeg`
- `image/png`
- `image/webp`
- `application/pdf`

The maximum file size is 10 MB.

Success response:

```json
{
  "cid": "bafy..."
}
```

## Error Shape

Application errors use this response shape:

```json
{
  "error": "Human-readable message",
  "requestId": "..."
}
```
