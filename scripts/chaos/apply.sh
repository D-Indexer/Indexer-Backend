#!/usr/bin/env bash
#
# apply.sh — apply a named toxic recipe to a Toxiproxy proxy.
#
# Part of issue #251: network fault injection for the local stack.
#
# Usage:
#   scripts/chaos/apply.sh <proxy> <toxic> [args...]
#
# Proxies (must match deploy/docker-compose.yml):
#   postgres   -> Postgres
#   kubo       -> Kubo (IPFS)
#   rpc        -> Stellar RPC
#
# Toxics:
#   latency <latency_ms> [jitter_ms]   add latency (+ optional jitter)
#   timeout <timeout_ms>               drop traffic after timeout
#   reset_peer <timeout_ms>            reset connections after timeout
#   bandwidth <rate_kbps>              limit bandwidth (KB/s)
#
# Environment:
#   TOXIPROXY_API   Toxiproxy HTTP API base URL (default: http://localhost:8474)
#
# Examples:
#   scripts/chaos/apply.sh rpc latency 5000
#   scripts/chaos/apply.sh postgres reset_peer 1000
#   scripts/chaos/apply.sh kubo bandwidth 64
#
set -euo pipefail

TOXIPROXY_API="${TOXIPROXY_API:-http://localhost:8474}"

usage() {
  cat >&2 <<'EOF'
Usage: apply.sh <proxy> <toxic> [args...]

Proxies: postgres | kubo | rpc
Toxics:
  latency <latency_ms> [jitter_ms]
  timeout <timeout_ms>
  reset_peer <timeout_ms>
  bandwidth <rate_kbps>

Environment:
  TOXIPROXY_API   Toxiproxy HTTP API base URL (default: http://localhost:8474)
EOF
  exit 2
}

if [[ $# -lt 2 ]]; then
  usage
fi

PROXY="$1"
TOXIC="$2"
shift 2

case "$PROXY" in
  postgres|kubo|rpc) ;;
  *)
    echo "error: unknown proxy '$PROXY' (expected: postgres, kubo, rpc)" >&2
    exit 2
    ;;
esac

# Build the toxic JSON payload.
case "$TOXIC" in
  latency)
    LATENCY_MS="${1:-}"
    JITTER_MS="${2:-0}"
    if [[ -z "$LATENCY_MS" ]]; then
      echo "error: latency requires <latency_ms>" >&2
      usage
    fi
    PAYLOAD=$(printf '{"name":"latency_downstream","type":"latency","stream":"downstream","toxicity":1.0,"attributes":{"latency":%s,"jitter":%s}}' \
      "$LATENCY_MS" "$JITTER_MS")
    ;;
  timeout)
    TIMEOUT_MS="${1:-}"
    if [[ -z "$TIMEOUT_MS" ]]; then
      echo "error: timeout requires <timeout_ms>" >&2
      usage
    fi
    PAYLOAD=$(printf '{"name":"timeout_downstream","type":"timeout","stream":"downstream","toxicity":1.0,"attributes":{"timeout":%s}}' \
      "$TIMEOUT_MS")
    ;;
  reset_peer)
    TIMEOUT_MS="${1:-}"
    if [[ -z "$TIMEOUT_MS" ]]; then
      echo "error: reset_peer requires <timeout_ms>" >&2
      usage
    fi
    PAYLOAD=$(printf '{"name":"reset_peer_downstream","type":"reset_peer","stream":"downstream","toxicity":1.0,"attributes":{"timeout":%s}}' \
      "$TIMEOUT_MS")
    ;;
  bandwidth)
    RATE_KBPS="${1:-}"
    if [[ -z "$RATE_KBPS" ]]; then
      echo "error: bandwidth requires <rate_kbps>" >&2
      usage
    fi
    PAYLOAD=$(printf '{"name":"bandwidth_downstream","type":"bandwidth","stream":"downstream","toxicity":1.0,"attributes":{"rate":%s}}' \
      "$RATE_KBPS")
    ;;
  *)
    echo "error: unknown toxic '$TOXIC' (expected: latency, timeout, reset_peer, bandwidth)" >&2
    usage
    ;;
esac

URL="${TOXIPROXY_API}/proxies/${PROXY}/toxics"

echo "Applying toxic '$TOXIC' to proxy '$PROXY' via $URL"

HTTP_CODE=$(curl -sS -o /tmp/toxiproxy-apply.out -w '%{http_code}' \
  -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD") || {
  echo "error: failed to reach Toxiproxy API at $TOXIPROXY_API" >&2
  exit 1
}

if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
  echo "error: Toxiproxy API returned HTTP $HTTP_CODE" >&2
  cat /tmp/toxiproxy-apply.out >&2 || true
  echo >&2
  exit 1
fi

echo "OK: toxic applied."
cat /tmp/toxiproxy-apply.out
echo
```

```bash
#!/usr/bin/env bash
#
# restore.sh — remove all toxics from all proxies and reset them.
#
# Part of issue #251: network fault injection for the local stack.
#
# Usage:
#   scripts/chaos/restore.sh [proxy...]
#
# With no arguments, restores every proxy (postgres, kubo, rpc).
#
# Environment:
#   TOXIPROXY_API   Toxiproxy HTTP API base URL (default: http://localhost:8474)
#
set -euo pipefail

TOXIPROXY_API="${TOXIPROXY_API:-http://localhost:8474}"

ALL_PROXIES=(postgres kubo rpc)

if [[ $# -gt 0 ]]; then
  PROXIES=("$@")
else
  PROXIES=("${ALL_PROXIES[@]}")
fi

fail=0

for PROXY in "${PROXIES[@]}"; do
  case "$PROXY" in
    postgres|kubo|rpc) ;;
    *)
      echo "error: unknown proxy '$PROXY' (expected: postgres, kubo, rpc)" >&2
      fail=1
      continue
      ;;
  esac

  # List toxics and delete each one.
  TOXICS_URL="${TOXIPROXY_API}/proxies/${PROXY}/toxics"
  if ! TOXIC_NAMES=$(curl -sS -f "$TOXICS_URL" | grep -o '"name":"[^"]*"' | sed 's/"name":"//;s/"$//'); then
    echo "error: failed to list toxics for proxy '$PROXY' at $TOXICS_URL" >&2
    fail=1
    continue
  fi

  if [[ -z "$TOXIC_NAMES" ]]; then
    echo "proxy '$PROXY': no toxics to remove"
  else
    while IFS= read -r NAME; do
      [[ -z "$NAME" ]] && continue
      if curl -sS -f -X DELETE "${TOXICS_URL}/${NAME}" >/dev/null; then
        echo "proxy '$PROXY': removed toxic '$NAME'"
      else
        echo "error: failed to remove toxic '$NAME' from proxy '$PROXY'" >&2
        fail=1
      fi
    done <<< "$TOXIC_NAMES"
  fi

  # Reset the proxy (re-enable it and clear any lingering state).
  if curl -sS -f -X POST "${TOXIPROXY_API}/proxies/${PROXY}" >/dev/null; then
    echo "proxy '$PROXY': reset"
  else
    echo "error: failed to reset proxy '$PROXY'" >&2
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "restore: completed with errors" >&2
  exit 1
fi

echo "restore: all proxies restored"
```

```bash
#!/usr/bin/env bash
#
# smoke.sh — verify each Toxiproxy proxy routes traffic to its upstream.
#
# Part of issue #251: network fault injection for the local stack.
#
# Checks:
#   postgres  -> psql through the Postgres proxy
#   kubo      -> `ipfs id` through the Kubo proxy
#   rpc       -> getLatestLedger call through the RPC proxy
#
# Usage:
#   scripts/chaos/smoke.sh
#
# Environment:
#   TOXIPROXY_API        Toxiproxy HTTP API base URL (default: http://localhost:8474)
#   POSTGRES_PROXY_ADDR  host:port of the Postgres proxy (default: localhost:15432)
#   KUBO_PROXY_ADDR      host:port of the Kubo proxy (default: localhost:15001)
#   RPC_PROXY_ADDR       host:port of the RPC proxy (default: localhost:18000)
#   POSTGRES_USER        Postgres user (default: postgres)
#   POSTGRES_PASSWORD    Postgres password (default: postgres)
#   POSTGRES_DB          Postgres database (default: postgres)
#
set -euo pipefail

TOXIPROXY_API="${TOXIPROXY_API:-http://localhost:8474}"
POSTGRES_PROXY_ADDR="${POSTGRES_PROXY_ADDR:-localhost:15432}"
KUBO_PROXY_ADDR="${KUBO_PROXY_ADDR:-localhost:15001}"
RPC_PROXY_ADDR="${RPC_PROXY_ADDR:-localhost:18000}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-postgres}"

fail=0

log() { printf '%s\n' "$*"; }
ok() { printf 'OK   %s\n' "$*"; }
err() { printf 'FAIL %s\n' "$*" >&2; fail=1; }

# --- 0. Toxiproxy API reachable ---------------------------------------------
log "Checking Toxiproxy API at $TOXIPROXY_API ..."
if curl -sS -f "${TOXIPROXY_API}/proxies" >/dev/null; then
  ok "Toxiproxy API reachable"
else
  err "Toxiproxy API not reachable at $TOXIPROXY_API"
  log "smoke: aborting (Toxiproxy not running)"
  exit 1
fi

# --- 1. Postgres proxy -------------------------------------------------------
log "Checking Postgres proxy at $POSTGRES_PROXY_ADDR ..."
PG_HOST="${POSTGRES_PROXY_ADDR%:*}"
PG_PORT="${POSTGRES_PROXY_ADDR##*:}"
if PGPASSWORD="$POSTGRES_PASSWORD" psql \
    -h "$PG_HOST" -p "$PG_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -tAc 'SELECT 1' >/dev/null 2>&1; then
  ok "Postgres proxy routes traffic"
else
  err "Postgres proxy did not route traffic ($POSTGRES_PROXY_ADDR)"
fi

# --- 2. Kubo proxy -----------------------------------------------------------
log "Checking Kubo proxy at $KUBO_PROXY_ADDR ..."
if IPFS_API="/ip4/127.0.0.1/tcp/${KUBO_PROXY_ADDR##*:}" ipfs id >/dev/null 2>&1; then
  ok "Kubo proxy routes traffic"
else
  err "Kubo proxy did not route traffic ($KUBO_PROXY_ADDR)"
fi

# --- 3. RPC proxy ------------------------------------------------------------
log "Checking RPC proxy at $RPC_PROXY_ADDR ..."
RPC_URL="http://${RPC_PROXY_ADDR}"
RPC_BODY='{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":[]}'
if RPC_RESP=$(curl -sS -f -X POST "$RPC_URL" \
    -H 'Content-Type: application/json' \
    -d "$RPC_BODY" 2>/dev/null) && [[ -n "$RPC_RESP" ]]; then
  ok "RPC proxy routes traffic"
else
  err "RPC proxy did not route traffic ($RPC_URL)"
fi

if [[ "$fail" -ne 0 ]]; then
  log "smoke: FAILED"
  exit 1
fi

log "smoke: all proxies route traffic"