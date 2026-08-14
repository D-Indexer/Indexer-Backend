# Monitoring

This folder documents observability assets and future dashboard/alert definitions.

Current operational signals:

- `/health` reports database status and indexer cursor
- request IDs are returned on responses
- startup, shutdown, and indexer failures are logged

Production systems should add metrics for:

- HTTP latency and error rate
- database latency
- indexer poll failures
- indexer cursor lag
- upload failures
