#!/bin/sh
# scripts/schema-upgrade-check.sh
#
# Verifies that the PR's database/schema.sql can be safely applied on top of an
# existing database created by the previous release (issue #249).
#
# Steps:
#   1. Start a throwaway Postgres and create two databases: `upgraded` and `fresh`.
#   2. Resolve the base ref (latest release tag, falling back to origin/main) and
#      export that tree into a temp dir.
#   3. Apply the base schema to `upgraded` and index fixture events with the base
#      indexer so the upgraded DB holds real data.
#   4. Apply the PR schema to `upgraded` twice (idempotency check).
#   5. Run the PR's Postgres-backed tests and API tests against `upgraded`.
#   6. Apply the PR schema to `fresh` and diff `pg_dump --schema-only` output of
#      `upgraded` vs `fresh`; fail on drift.
#   7. Always stop/remove the container.

set -eu

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PG_IMAGE="${PG_IMAGE:-postgres:16}"
PG_USER="${PG_USER:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-postgres}"
PG_DB_UPGRADED="upgraded"
PG_DB_FRESH="fresh"
FIXTURE_EVENTS="src/__tests__/fixtures/testnet-events.json"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CONTAINER_NAME="schema-upgrade-check-$$"
WORK_DIR=""
BASE_DIR=""
CONTAINER_STARTED=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
  printf '[schema-upgrade-check] %s\n' "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

cleanup() {
  status=$?
  if [ "$CONTAINER_STARTED" -eq 1 ]; then
    log "Stopping and removing container $CONTAINER_NAME"
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
  exit "$status"
}

trap cleanup EXIT INT TERM

# Find a free TCP port by asking the OS for an ephemeral one.
find_free_port() {
  node -e '
    const net = require("net");
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => process.stdout.write(String(port)));
    });
  '
}

# Wait until Postgres inside the container accepts connections.
wait_for_postgres() {
  port="$1"
  attempts=0
  max_attempts=120
  while [ "$attempts" -lt "$max_attempts" ]; do
    if docker exec "$CONTAINER_NAME" pg_isready -U "$PG_USER" -d postgres >/dev/null 2>&1; then
      # pg_isready can report ready before the server accepts auth'd queries.
      if PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$port" -U "$PG_USER" -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
        return 0
      fi
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

psql_db() {
  db="$1"
  shift
  PGPASSWORD="$PG_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$db" "$@"
}

# ---------------------------------------------------------------------------
# 1. Start throwaway Postgres
# ---------------------------------------------------------------------------

log "Starting throwaway Postgres ($PG_IMAGE)"
PG_PORT="$(find_free_port)"
[ -n "$PG_PORT" ] || fail "could not determine a free port"

docker run -d \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB=postgres \
  -p "127.0.0.1:${PG_PORT}:5432" \
  "$PG_IMAGE" >/dev/null
CONTAINER_STARTED=1

if ! wait_for_postgres "$PG_PORT"; then
  log "Postgres container logs:"
  docker logs "$CONTAINER_NAME" >&2 || true
  fail "Postgres did not become ready"
fi
log "Postgres ready on port $PG_PORT"

psql_db postgres -c "CREATE DATABASE $PG_DB_UPGRADED" >/dev/null
psql_db postgres -c "CREATE DATABASE $PG_DB_FRESH" >/dev/null

UPGRADED_URL="postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB_UPGRADED}"
FRESH_URL="postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB_FRESH}"

# ---------------------------------------------------------------------------
# 2. Resolve base ref and export it
# ---------------------------------------------------------------------------

WORK_DIR="$(mktemp -d)"
BASE_DIR="$WORK_DIR/base"

BASE_REF=""
if BASE_TAG="$(git describe --tags --abbrev=0 2>/dev/null)"; then
  BASE_REF="$BASE_TAG"
  log "Using latest release tag as base: $BASE_REF"
else
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    BASE_REF="origin/main"
  elif git rev-parse --verify main >/dev/null 2>&1; then
    BASE_REF="main"
  else
    fail "could not resolve a base ref (no release tag, no origin/main, no main)"
  fi
  log "No release tag found; falling back to base ref: $BASE_REF"
fi

mkdir -p "$BASE_DIR"
git archive "$BASE_REF" | tar -x -C "$BASE_DIR" || fail "failed to export base tree from $BASE_REF"

[ -f "$BASE_DIR/database/schema.sql" ] || fail "base tree ($BASE_REF) has no database/schema.sql"
[ -f "$REPO_ROOT/database/schema.sql" ] || fail "PR tree has no database/schema.sql"

# ---------------------------------------------------------------------------
# 3. Apply base schema + index fixture events with the base indexer
# ---------------------------------------------------------------------------

log "Applying base schema ($BASE_REF) to $PG_DB_UPGRADED"
psql_db "$PG_DB_UPGRADED" -f "$BASE_DIR/database/schema.sql" >/dev/null \
  || fail "failed to apply base schema from $BASE_REF"

if [ -f "$BASE_DIR/$FIXTURE_EVENTS" ]; then
  log "Indexing fixture events with base indexer into $PG_DB_UPGRADED"
  (
    cd "$BASE_DIR"
    if [ ! -d node_modules ]; then
      if [ -f package-lock.json ]; then
        npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1
      else
        npm install --no-audit --no-fund >/dev/null 2>&1
      fi
    fi
    DATABASE_URL="$UPGRADED_URL" \
    FIXTURE_EVENTS="$FIXTURE_EVENTS" \
    node -r ts-node/register -e '
      const fs = require("fs");
      const path = require("path");
      const fixturePath = process.env.FIXTURE_EVENTS;
      const raw = fs.readFileSync(fixturePath, "utf8");
      const parsed = JSON.parse(raw);
      const events = Array.isArray(parsed) ? parsed : (parsed.events || parsed.records || []);
      const candidates = [
        "./src/indexer",
        "./src/indexer/index",
        "./src/indexer/processPage",
        "./src/indexer/process-page",
      ];
      let mod = null;
      for (const c of candidates) {
        try {
          mod = require(c);
          break;
        } catch (e) {
          if (e && e.code !== "MODULE_NOT_FOUND") throw e;
        }
      }
      if (!mod) {
        console.error("could not locate base indexer module");
        process.exit(1);
      }
      const fn = mod.processPage || mod.default || mod.indexEvents || mod.run;
      if (typeof fn !== "function") {
        console.error("base indexer module does not export a callable entry point");
        process.exit(1);
      }
      Promise.resolve(fn(events))
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(err);
          process.exit(1);
        });
    ' || fail "base indexer failed against $PG_DB_UPGRADED"
  )
else
  log "WARNING: base tree has no $FIXTURE_EVENTS; skipping fixture indexing"
fi

# ---------------------------------------------------------------------------
# 4. Apply PR schema to upgraded DB twice (idempotency)
# ---------------------------------------------------------------------------

log "Applying PR schema to $PG_DB_UPGRADED (first pass)"
DATABASE_URL="$UPGRADED_URL" npm run db:migrate \
  || fail "PR schema failed to apply on upgraded database (first pass)"

log "Applying PR schema to $PG_DB_UPGRADED (second pass, idempotency)"
DATABASE_URL="$UPGRADED_URL" npm run db:migrate \
  || fail "PR schema is not idempotent: second application failed on upgraded database"

# ---------------------------------------------------------------------------
# 5. Run PR tests against the upgraded DB
# ---------------------------------------------------------------------------

log "Running Postgres-backed tests against upgraded database"
TEST_DATABASE_URL="$UPGRADED_URL" DATABASE_URL="$UPGRADED_URL" npm test \
  || fail "PR tests failed against upgraded database"

log "Running API tests against upgraded database"
DATABASE_URL="$UPGRADED_URL" npm run test:api \
  || fail "PR API tests failed against upgraded database"

# ---------------------------------------------------------------------------
# 6. Apply PR schema to fresh DB and compare schemas
# ---------------------------------------------------------------------------

log "Applying PR schema to $PG_DB_FRESH"
DATABASE_URL="$FRESH_URL" npm run db:migrate \
  || fail "PR schema failed to apply on fresh database"

DUMP_DIR="$WORK_DIR/dumps"
mkdir -p "$DUMP_DIR"

dump_schema() {
  db="$1"
  out="$2"
  PGPASSWORD="$PG_PASSWORD" pg_dump \
    --schema-only --no-owner --no-privileges \
    -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$db" >"$out" \
    || fail "pg_dump failed for database $db"
  # Normalise volatile lines that legitimately differ between databases.
  sed -E \
    -e '/^-- Dumped (from|by) /d' \
    -e '/^-- Dumped on /d' \
    -e '/^SET /d' \
    -e '/^SELECT pg_catalog.set_config/d' \
    -e '/^\\restrict /d' \
    -e '/^\\unrestrict /d' \
    -e 's/^-- Name: .*; Type: .*; Schema: .*; Owner: .*$/-- Name: &/' \
    "$out" >"$out.norm"
}

log "Dumping schemas for comparison"
dump_schema "$PG_DB_UPGRADED" "$DUMP_DIR/upgraded.sql"
dump_schema "$PG_DB_FRESH" "$DUMP_DIR/fresh.sql"

if ! diff -u "$DUMP_DIR/fresh.sql.norm" "$DUMP_DIR/upgraded.sql.norm" >"$DUMP_DIR/schema.diff"; then
  log "Schema drift detected between upgraded and fresh databases:"
  cat "$DUMP_DIR/schema.diff" >&2
  fail "upgraded schema differs from fresh schema (see diff above)"
fi

log "Upgraded and fresh schemas are identical"
log "Schema upgrade check passed"