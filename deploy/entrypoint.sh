#!/bin/sh
# Entrypoint for the API and indexer containers.
#
# Sizes the Node.js heap from the container memory limit so that V8 garbage
# collects before the kernel OOM-kills the process. Older Node versions size
# the heap from host memory rather than the cgroup limit, and buffered uploads
# create large transient allocations, so an explicit limit is important.
#
# Behaviour:
#   - Reads the cgroup v2 (/sys/fs/cgroup/memory.max) or v1
#     (/sys/fs/cgroup/memory/memory.limit_in_bytes) memory limit.
#   - Defaults --max-old-space-size to 75% of that limit.
#   - Respects an explicit --max-old-space-size in NODE_OPTIONS.
#   - Logs the effective heap limit at startup.
#   - execs the container command.

set -eu

log() {
    printf '[entrypoint] %s\n' "$*" >&2
}

# Read the container memory limit in bytes. Prints nothing if unlimited or
# unavailable.
read_memory_limit() {
    limit=""

    # cgroup v2
    if [ -r /sys/fs/cgroup/memory.max ]; then
        limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)
        if [ "$limit" = "max" ]; then
            limit=""
        fi
    fi

    # cgroup v1 (also used as a fallback if v2 was unlimited)
    if [ -z "$limit" ] && [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)
        # v1 reports a huge sentinel value when unlimited.
        case "$limit" in
            ''|*[!0-9]*) limit="" ;;
            *)
                if [ "$limit" -ge 9223372036854771712 ] 2>/dev/null; then
                    limit=""
                fi
                ;;
        esac
    fi

    printf '%s' "$limit"
}

# Returns success if NODE_OPTIONS already sets --max-old-space-size.
has_explicit_heap_limit() {
    case "${NODE_OPTIONS:-}" in
        *--max-old-space-size*) return 0 ;;
        *) return 1 ;;
    esac
}

LIMIT_BYTES=$(read_memory_limit)

if has_explicit_heap_limit; then
    log "NODE_OPTIONS already sets --max-old-space-size; leaving heap limit unchanged"
    log "effective NODE_OPTIONS: ${NODE_OPTIONS:-}"
elif [ -n "$LIMIT_BYTES" ]; then
    # 75% of the container limit, in MiB.
    HEAP_MB=$((LIMIT_BYTES / 1024 / 1024 * 75 / 100))

    if [ "$HEAP_MB" -lt 64 ]; then
        log "WARNING: computed heap limit (${HEAP_MB} MiB) is very small; using 64 MiB"
        HEAP_MB=64
    fi

    NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${HEAP_MB}"
    # Trim leading whitespace introduced when NODE_OPTIONS was unset.
    NODE_OPTIONS=$(printf '%s' "$NODE_OPTIONS" | sed 's/^[[:space:]]*//')
    export NODE_OPTIONS

    log "container memory limit: $((LIMIT_BYTES / 1024 / 1024)) MiB"
    log "effective heap limit: ${HEAP_MB} MiB (--max-old-space-size)"
    log "effective NODE_OPTIONS: ${NODE_OPTIONS}"
else
    log "no container memory limit detected; leaving Node heap sizing to defaults"
    log "effective NODE_OPTIONS: ${NODE_OPTIONS:-<unset>}"
fi

exec "$@"