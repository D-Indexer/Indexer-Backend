# Security Notes

This service is an API and indexer layer. It does not replace the Folder contract as the source of truth.

## Current Controls

- strict environment validation at startup
- request IDs for response correlation
- basic security headers
- CORS allowlist support through `CORS_ORIGIN`
- JSON body size limit
- upload MIME allowlist
- upload size limit
- parameterized PostgreSQL queries
- non-sensitive error messages for unexpected failures

## Secrets

Keep these out of source control:

- database credentials
- IPFS credentials if the Kubo endpoint requires authentication
- webhook secrets
- deployment provider tokens

`.env` is ignored by git. Update `.env.example` with names and safe defaults only.

## Uploads

Uploads are validated by MIME type and size before pinning. The service currently trusts the MIME type provided by the multipart parser. If upload trust requirements increase, add content sniffing before pinning.

## CORS

By default, development allows any origin. Production deployments should set `CORS_ORIGIN` to a comma-separated allowlist.

Example:

```text
CORS_ORIGIN=https://folder.example,https://staging.folder.example
```

## Database

Use least-privilege database credentials in production. The application user needs table creation permissions for migrations and read/write permissions for runtime tables.
