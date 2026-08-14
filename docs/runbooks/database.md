# Database Runbook

## Verify connectivity

Use `/health` first. If it returns `503`, verify `DATABASE_URL` and PostgreSQL availability.

## Apply migrations

```bash
npm run db:migrate
```

## Rebuild indexed state

Recreate the database, run migrations, set the desired cursor, and restart the service.
