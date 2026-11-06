#!/usr/bin/env bash
# Frameback cutover: replace the live ViTransfer stack on port 4324 (docs/redesign/PLAN.md §8.3).
#
#   scripts/cutover/cutover.sh init-env            create ~/frameback/.env from live
#   scripts/cutover/cutover.sh rehearsal           full dry run on port 4327, live untouched,
#                                                  no internet for the rehearsal stack
#   scripts/cutover/cutover.sh rehearsal-down      remove the rehearsal stack incl. volumes
#   scripts/cutover/cutover.sh go --yes            the real cutover (downtime a few minutes)
#   scripts/cutover/cutover.sh rollback --yes      back to the old stack (data written in
#                                                  Frameback since the cutover is NOT carried back)
#
# Live is only read (pg_dump, read-only volume mount) except in `go`/`rollback`, which stop
# and start the live app/worker containers. Live containers and volumes are never deleted.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LIVE_DIR="${LIVE_DIR:-~/vitransfer}"
PROD_DIR="${PROD_DIR:-~/frameback}"
ENV_FILE="$PROD_DIR/.env"
LIVE_ENV="$LIVE_DIR/.env"
LIVE_APP=vitransfer-app LIVE_WORKER=vitransfer-worker LIVE_PG=vitransfer-postgres LIVE_REDIS=vitransfer-redis
LIVE_UPLOADS=vitransfer_uploads
PROD_PROJECT=frameback REH_PROJECT=frameback-rehearsal
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUPS="$PROD_DIR/backups"
T0=$(date +%s)

log()  { printf '\n[%4ss] == %s\n' "$(( $(date +%s) - T0 ))" "$*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
envval() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
prod()  { docker compose -p "$PROD_PROJECT" --env-file "$ENV_FILE" -f "$REPO_DIR/deploy/prod/docker-compose.yml" "$@"; }
reh()   { docker compose -p "$REH_PROJECT" --env-file "$ENV_FILE" -f "$REPO_DIR/deploy/prod/docker-compose.yml" -f "$REPO_DIR/deploy/prod/rehearsal.override.yml" "$@"; }
need_yes() { [[ " $* " == *" --yes "* ]] || die "refusing without --yes"; }

restore_dump() { # $1 = compose function name, $2 = dump file
  local c=$1 dump=$2
  $c exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qc "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"'
  $c exec -T postgres sh -c 'pg_restore --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$dump"
}

copy_uploads() { # $1 = target volume, $2 = "full" | "delta"
  docker volume create "$1" >/dev/null
  if [[ "$2" == full ]]; then
    docker run --rm -v "$LIVE_UPLOADS":/from:ro -v "$1":/to alpine:3 sh -c 'find /to -mindepth 1 -delete && cp -a /from/. /to/ && du -sh /to'
  else
    docker run --rm -v "$LIVE_UPLOADS":/from:ro -v "$1":/to alpine:3 sh -c 'apk add --no-cache rsync >/dev/null && rsync -a --delete /from/ /to/ && du -sh /to'
  fi
}

dump_live() { # $1 = target file
  mkdir -p "$BACKUPS"
  docker exec "$LIVE_PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$1"
  [[ -s "$1" ]] || die "empty dump"
  ls -lh "$1"
}

wait_healthy() { # $1 = url
  for _ in $(seq 1 90); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$1/api/health")" == 200 ]] && return 0
    sleep 4
  done
  return 1
}

smoke() { # $1 = base url
  local slug
  slug=$(echo "select slug from \"Project\" where \"authMode\"='NONE' and not \"guestMode\" and status in ('IN_REVIEW','APPROVED') limit 1;" \
    | docker exec -i "$LIVE_PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA' | tr -d '\r\n')
  (cd "$REPO_DIR" && E2E_BASE_URL="$1" E2E_SHARE_SLUG="$slug" npx playwright test --project=desktop --reporter=line)
}

case "${1:-}" in
  init-env)
    [[ -f "$ENV_FILE" ]] && die "$ENV_FILE exists – not overwriting"
    mkdir -p "$PROD_DIR"
    python3 -I - "$LIVE_ENV" "$ENV_FILE" "${2:-}" <<'PY'
import os, re, secrets, sys
live, out, image = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(live, encoding='utf-8').read().splitlines()
override = {
  # new secrets: one-time re-login for everyone; revoked live tokens can't come back
  'JWT_SECRET': secrets.token_hex(48), 'JWT_REFRESH_SECRET': secrets.token_hex(48), 'SHARE_TOKEN_SECRET': secrets.token_hex(48),
  # own database / redis
  'POSTGRES_PASSWORD': secrets.token_hex(24), 'REDIS_PASSWORD': secrets.token_hex(24),
  'APP_PORT': '4324', 'HTTPS_ENABLED': 'true', 'TRUST_PROXY': 'true',
}
outl, seen = [], set()
for l in lines:
    m = re.match(r'^([A-Z_][A-Z0-9_]*)=', l)
    if m and m.group(1) in override:
        k = m.group(1); seen.add(k); outl.append(f'{k}={override[k]}')
    else:
        outl.append(l)
for k, v in override.items():
    if k not in seen: outl.append(f'{k}={v}')
outl += [f'FRAMEBACK_IMAGE={image}', 'REHEARSAL_PORT=4327', 'FEATURE_NEW_SHARE=true', 'FEATURE_REVIEW_FLOW=false', 'NEXT_PUBLIC_SOURCE_CODE_URL=']
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(fd, ('# Frameback production. ENCRYPTION_KEY from live; JWT/share secrets, DB and Redis passwords new.\n' + '\n'.join(outl) + '\n').encode())
os.close(fd)
print('written', out)
PY
    ;;

  rehearsal)
    [[ -f "$ENV_FILE" ]] || die "run init-env first"
    PORT="$(envval REHEARSAL_PORT "$ENV_FILE")"; PORT="${PORT:-4327}"
    URL="http://127.0.0.1:$PORT"
    docker image inspect "$(envval FRAMEBACK_IMAGE "$ENV_FILE")" >/dev/null || die "image missing"
    log "Rehearsal: live keeps running; rehearsal stack has no internet; port $PORT"
    reh down >/dev/null 2>&1 || true
    log "Dump live (read-only)"
    DUMP="$BACKUPS/rehearsal-$STAMP.dump"; dump_live "$DUMP"
    log "Database"
    reh up -d --wait postgres redis
    restore_dump reh "$DUMP"
    log "Sanitize (no SMTP / push / webhooks, like staging)"
    reh exec -T postgres sh -c "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v app_domain='$URL'" < "$REPO_DIR/scripts/staging/sanitize.sql" >/dev/null
    log "Uploads (full copy – the real cutover pre-seeds this before the downtime)"
    copy_uploads "${REH_PROJECT}_uploads" full
    log "Start app (runs migrations) + worker"
    D0=$(date +%s)
    reh up -d app worker proxy
    wait_healthy "$URL" || die "app not healthy"
    echo "app ready after $(( $(date +%s) - D0 ))s (≈ downtime part for migrations/start)"
    log "Check report"
    PROJECT="$REH_PROJECT" ENV_FILE="$ENV_FILE" REPORT_MODE=rehearsal \
      COMPOSE_ARGS="-f $REPO_DIR/deploy/prod/docker-compose.yml -f $REPO_DIR/deploy/prod/rehearsal.override.yml" \
      "$REPO_DIR/scripts/staging/report.sh"
    log "Smoke tests (Playwright)"
    smoke "$URL"
    log "Rehearsal OK. Inspect at $URL ; remove with: $0 rehearsal-down"
    ;;

  rehearsal-down)
    reh down -v
    ;;

  go)
    need_yes "$@"
    [[ -f "$ENV_FILE" ]] || die "run init-env first"
    IMAGE="$(envval FRAMEBACK_IMAGE "$ENV_FILE")"
    docker image inspect "$IMAGE" >/dev/null || die "image $IMAGE missing"
    docker inspect -f '{{.State.Running}}' "$LIVE_APP" | grep -q true || die "live app is not running – nothing to cut over?"
    [[ -z "$(prod ps -q app 2>/dev/null)" ]] || die "frameback app already exists – use rollback first"
    LIVE_REDIS_PW="$(envval REDIS_PASSWORD "$LIVE_ENV")"

    log "Pre-seed uploads while live still runs"
    copy_uploads "${PROD_PROJECT}_uploads" full

    log "DOWNTIME START – stop live app"
    docker stop "$LIVE_APP" >/dev/null
    log "Wait for live worker queues to drain (max 5 min)"
    for _ in $(seq 1 60); do
      ACTIVE=$(docker exec "$LIVE_REDIS" sh -c "redis-cli --no-auth-warning -a '$LIVE_REDIS_PW' --scan --pattern 'bull:*:active' | xargs -r -n1 redis-cli --no-auth-warning -a '$LIVE_REDIS_PW' llen | awk '{s+=\$1} END {print s+0}'")
      [[ "$ACTIVE" == 0 ]] && break
      echo "active jobs: $ACTIVE"; sleep 5
    done
    docker stop "$LIVE_WORKER" >/dev/null

    log "Final dump of live"
    DUMP="$BACKUPS/cutover-$STAMP.dump"; dump_live "$DUMP"
    log "Uploads delta"
    copy_uploads "${PROD_PROJECT}_uploads" delta

    log "Frameback database"
    prod up -d --wait postgres redis
    restore_dump prod "$DUMP"
    prod exec -T redis sh -c "redis-cli --no-auth-warning -a '$(envval REDIS_PASSWORD "$ENV_FILE")' FLUSHALL" >/dev/null

    rollback_now() {
      echo "!! checks failed – rolling back to the old stack" >&2
      prod stop app worker || true
      docker start "$LIVE_WORKER" "$LIVE_APP" >/dev/null
      echo "!! old stack running again on 4324. Frameback containers kept for inspection." >&2
      exit 1
    }
    log "Start Frameback app (migrations) on 4324 + worker"
    prod up -d app || rollback_now
    wait_healthy "http://127.0.0.1:$(envval APP_PORT "$ENV_FILE")" || rollback_now
    prod up -d worker || rollback_now
    log "DOWNTIME END (app answering)"

    log "Check report"
    PROJECT="$PROD_PROJECT" ENV_FILE="$ENV_FILE" REPORT_MODE=production \
      COMPOSE_ARGS="-f $REPO_DIR/deploy/prod/docker-compose.yml" \
      "$REPO_DIR/scripts/staging/report.sh" || rollback_now
    log "Smoke tests"
    smoke "http://127.0.0.1:$(envval APP_PORT "$ENV_FILE")" || rollback_now

    # Old containers must not come back after a reboot; they stay for 14 days as fallback
    docker update --restart=no "$LIVE_APP" "$LIVE_WORKER" >/dev/null
    log "Cutover complete. Live dump kept at $DUMP. Old stack stopped (not removed)."
    ;;

  rollback)
    need_yes "$@"
    echo "Rolling back: Frameback app/worker stop, old ViTransfer app/worker start."
    echo "Comments/decisions made in Frameback since the cutover are NOT carried back."
    prod stop app worker || true
    docker update --restart=unless-stopped "$LIVE_APP" "$LIVE_WORKER" >/dev/null
    docker start "$LIVE_WORKER" "$LIVE_APP" >/dev/null
    log "Old stack running on 4324 again"
    ;;

  *)
    sed -n '2,15p' "$0"; exit 1
    ;;
esac
