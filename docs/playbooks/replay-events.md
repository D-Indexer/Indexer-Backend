# Playbook: Replay Events

1. stop the backend
2. update or clear `indexer_state.indexer_cursor`
3. ensure migrations are applied
4. restart the backend
5. monitor indexer logs
