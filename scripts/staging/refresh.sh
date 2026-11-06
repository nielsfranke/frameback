#!/usr/bin/env bash
# Refresh the ViTransfer "next" staging stack with a copy of live data.
#
# Read-only towards live: pg_dump from the live postgres container and a
# read-only mount of the live uploads volume. Nothing on live is changed.
#
# Order matters: staging app/worker stay stopped until the restored database is
# sanitized (no SMTP, no push, no webhooks, empty notification queue).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE_DIR="${STAGE_DIR:-${HOME}/vitransfer-next}"
ENV_FILE="$STAGE_DIR/.env"
PROJECT="vitransfer-next"
LIVE_PG_CONTAINER="${LIVE_PG_CONTAINER:-vitransfer-postgres}"
LIVE_UPLOADS_VOLUME="${LIVE_UPLOADS_VOLUME:-vitransfer_uploads}"
STAGE_UPLOADS_VOLUME="${PROJECT}_uploads"

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$REPO_DIR/deploy/next/docker-compose.yml" "$@"; }
envval() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
log() { printf '\n== %s\n' "$*"; }

[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
[[ "$STAGE_UPLOADS_VOLUME" != "$LIVE_UPLOADS_VOLUME" ]] || { echo "refusing: staging volume equals live volume" >&2; exit 1; }
APP_DOMAIN="$(envval NEXT_PUBLIC_APP_URL)"
[[ -n "$APP_DOMAIN" ]] || { echo "NEXT_PUBLIC_APP_URL missing in $ENV_FILE" >&2; exit 1; }

mkdir -p "$STAGE_DIR/dumps"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$STAGE_DIR/dumps/live-$STAMP.dump"

log "Stopping staging app, worker and proxy"
compose stop app worker caddy 2>/dev/null || true

log "Dumping live database (read-only) -> $DUMP"
docker exec "$LIVE_PG_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DUMP"
ls -lh "$DUMP"

log "Starting staging postgres and redis"
compose up -d --wait postgres redis

log "Restoring into staging database"
compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qc "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"'
compose exec -T postgres sh -c 'pg_restore --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$DUMP"

log "Sanitizing staging database (before any app start)"
compose exec -T postgres sh -c "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v app_domain='$APP_DOMAIN'" < "$REPO_DIR/scripts/staging/sanitize.sql"

log "Copying uploads (live volume mounted read-only)"
compose create --no-recreate app >/dev/null 2>&1 || true   # lets compose own the uploads volume
docker run --rm -v "$LIVE_UPLOADS_VOLUME":/from:ro -v "$STAGE_UPLOADS_VOLUME":/to alpine:3 \
  sh -c 'find /to -mindepth 1 -delete && cp -a /from/. /to/ && du -sh /to'

log "Flushing staging redis (sessions start fresh, like the planned cutover)"
[[ "$(compose exec -T redis redis-cli --no-auth-warning -a "$(envval REDIS_PASSWORD)" FLUSHALL | tr -d '\r')" == "OK" ]] \
  || { echo "redis FLUSHALL failed" >&2; exit 1; }

log "Starting app, worker and proxy"
compose up -d
echo "Staging: $APP_DOMAIN  (run scripts/staging/report.sh for the check report)"
