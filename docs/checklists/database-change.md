# Database Change Checklist

- update `src/db/migrate.ts`
- keep migrations idempotent
- update service row mapping types
- add query or mapper tests
- update schema docs
- consider replay impact for existing indexed data
