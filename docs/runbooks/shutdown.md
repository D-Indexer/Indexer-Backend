# Shutdown Runbook

The server handles `SIGTERM` and `SIGINT`.

Expected sequence:

1. stop indexer scheduling
2. close HTTP server
3. close PostgreSQL pool
4. exit process

If shutdown hangs, review `SHUTDOWN_TIMEOUT_MS`.
