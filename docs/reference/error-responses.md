# Error Responses

Errors are JSON objects with an `error` message and `requestId`.

Unexpected server errors intentionally return a generic message to avoid leaking internals.
