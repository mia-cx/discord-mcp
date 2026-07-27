#!/bin/sh
set -eu

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"stdio-purity-test","version":"1.0.0"}}}'

set +e
printf '%s\n' "$initialize" |
  env \
    DISCORD_TOKEN=test-token-never-sent \
    DATABASE_PATH="$test_root/control-plane.sqlite" \
    DISCORD_MCP_BLOB_DIR="$test_root/blobs" \
    MCP_TRANSPORT=stdio \
    DISCORD_MCP_GATEWAY_MODE=off \
    timeout 5s node apps/server/dist/main.js \
      >"$test_root/stdout" 2>"$test_root/stderr"
status=$?
set -e

if [ "$status" -ne 0 ] && [ "$status" -ne 124 ]; then
  printf 'stdio subprocess exited %s\n' "$status" >&2
  sed -n '1,80p' "$test_root/stderr" >&2
  exit 1
fi

node scripts/validate-stdio-output.mjs "$test_root/stdout" "$test_root/stderr"
