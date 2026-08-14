# Data Retention

The backend stores indexed Folder metadata, credential proof hashes, template metadata CIDs, and cursor state.

Uploaded file bytes are sent to IPFS and are not stored directly in PostgreSQL.
