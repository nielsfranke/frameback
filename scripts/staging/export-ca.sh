#!/usr/bin/env bash
# Export the staging Caddy internal root CA, e.g. for the Resolve MCP:
#   SSL_CERT_FILE=~/vitransfer-next/staging-root.crt resolve-studio-mcp ...
set -euo pipefail
STAGE_DIR="${STAGE_DIR:-${HOME}/vitransfer-next}"
OUT="$STAGE_DIR/staging-root.crt"
docker run --rm -v vitransfer-next_caddy-data:/data:ro alpine:3 cat /data/caddy/pki/authorities/local/root.crt > "$OUT"
echo "$OUT"
