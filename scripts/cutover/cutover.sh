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
# Overridable for the tooling's own tests (e.g. staging as stand-in for live, see docs)
LIVE_APP="${LIVE_APP:-vitransfer-app}" LIVE_WORKER="${LIVE_WORKER:-vitransfer-worker}"
LIVE_PG="${LIVE_PG:-vitransfer-postgres}" LIVE_REDIS="${LIVE_REDIS:-vitransfer-redis}"
LIVE_UPLOADS="${LIVE_UPLOADS:-vitransfer_uploads}"
LIVE_ENV="${LIVE_ENV:-$LIVE_DIR/.env}"
PROD_PROJECT="${PROD_PROJECT:-frameback}" REH_PROJECT=frameback-rehearsal
CHECK_PORT="${CHECK_PORT:-4328}"
# Where the OLD stack answers after a restore (live: the same public port)
OLD_HEALTH_URL="${OLD_HEALTH_URL:-}"
# Test hook: FAIL_AT=<step> forces a failure at that step to exercise the recovery path
fail_at() { [[ "${FAIL_AT:-}" == "$1" ]] && { echo "!! FAIL_AT=$1 (test)" >&2; return 1; } || return 0; }
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUPS="$PROD_DIR/backups"
T0=$(date +%s)

log()  { printf '\n[%4ss] == %s\n' "$(( $(date +%s) - T0 ))" "$*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
envval() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
prod()  { docker compose -p "$PROD_PROJECT" --env-file "$ENV_FILE" -f "$REPO_DIR/deploy/prod/docker-compose.yml" "$@"; }
reh()   { docker compose -p "$REH_PROJECT" --env-file "$ENV_FILE" -f "$REPO_DIR/deploy/prod/docker-compose.yml" -f "$REPO_DIR/deploy/prod/rehearsal.override.yml" "$@"; }
# 0 = some Frameback app/worker container is running/restarting (or state unknown), 1 = all stopped
frameback_active() {
  local ids id st
  ids=$(prod ps -a -q app worker 2>/dev/null) || return 0
  for id in $ids; do
    st=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null) || return 0
    [[ "$st" == running || "$st" == restarting ]] && return 0
  done
  return 1
}
policy_of() { docker inspect -f '{{.HostConfig.RestartPolicy.Name}}{{if gt .HostConfig.RestartPolicy.MaximumRetryCount 0}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}{{end}}' "$1"; }
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
    [[ "$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "$1/api/health")" == 200 ]] && return 0
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
    exec 9>"$PROD_DIR/.cutover.lock"; flock -n 9 || die "another cutover/rollback is running"
    [[ -f "$ENV_FILE" ]] || die "run init-env first"
    IMAGE="$(envval FRAMEBACK_IMAGE "$ENV_FILE")"
    docker image inspect "$IMAGE" postgres:16-alpine redis:7-alpine alpine:3 >/dev/null || die "images missing (pull/build first)"
    docker inspect -f '{{.State.Running}}' "$LIVE_APP" | grep -q true || die "live app is not running – nothing to cut over?"
    # Never overwrite an existing Frameback installation (running OR stopped, or its DB volume)
    [[ -z "$(prod ps -a -q 2>/dev/null)" ]] || die "frameback containers exist – inspect / remove them deliberately first"
    docker volume inspect "${PROD_PROJECT}_postgres-data" >/dev/null 2>&1 && die "volume ${PROD_PROJECT}_postgres-data exists – refusing to overwrite"
    prod config -q || die "compose config invalid"
    LIVE_REDIS_PW="$(envval REDIS_PASSWORD "$LIVE_ENV")"
    PROD_REDIS_PW="$(envval REDIS_PASSWORD "$ENV_FILE")"
    PUBLIC_PORT="$(envval APP_PORT "$ENV_FILE")"; PUBLIC_PORT="${PUBLIC_PORT:-4324}"
    umask 077

    # Tool image for the delta sync, built BEFORE the downtime (no downloads while offline)
    docker image inspect frameback-rsync:local >/dev/null 2>&1 || \
      printf 'FROM alpine:3\nRUN apk add --no-cache rsync\n' | docker build -q -t frameback-rsync:local - >/dev/null
    # Remember the live restart policies (incl. retry counts) and run states for an exact restore
    POL_APP=$(policy_of "$LIVE_APP"); POL_WORKER=$(policy_of "$LIVE_WORKER")
    WORKER_WAS_RUNNING=$(docker inspect -f '{{.State.Running}}' "$LIVE_WORKER")
    printf 'POL_APP=%q\nPOL_WORKER=%q\nWORKER_WAS_RUNNING=%q\n' "$POL_APP" "$POL_WORKER" "$WORKER_WAS_RUNNING" > "$PROD_DIR/.live-restart-policies"
    # Check port free, enough disk for a full uploads copy (+10 %)
    ! ss -ltn "sport = :$CHECK_PORT" | grep -q LISTEN || die "port $CHECK_PORT busy"
    NEED_KB=$(docker run --rm -v "$LIVE_UPLOADS":/u:ro alpine:3 du -sk /u | cut -f1)
    FREE_KB=$(df -k --output=avail /var/lib/docker | tail -1)
    (( FREE_KB > NEED_KB * 11 / 10 )) || die "not enough disk space for the uploads copy"

    log "Pre-seed uploads while live still runs"
    copy_uploads "${PROD_PROJECT}_uploads" full

    # From here on ANY non-zero exit (die, a failed command, Ctrl-C) restores the old stack –
    # until Frameback is published. An EXIT trap is used (not ERR), so subshells and
    # functions cannot trigger the recovery twice.
    PHASE=down
    restore_live() {
      echo "!! aborting (phase $PHASE) – restoring the old stack" >&2
      prod stop -t 30 app worker >/dev/null 2>&1 || true
      if frameback_active; then
        echo "!! Frameback app/worker still running (or state unknown) – NOT starting the old stack (port conflict). Fix manually, then: $0 rollback --yes" >&2
        return
      fi
      for id in $(prod ps -a -q app worker 2>/dev/null); do docker update --restart=no "$id" >/dev/null 2>&1 || true; done
      docker update --restart="$POL_APP" "$LIVE_APP" >/dev/null; docker update --restart="$POL_WORKER" "$LIVE_WORKER" >/dev/null
      [[ "$WORKER_WAS_RUNNING" == true ]] && docker start "$LIVE_WORKER" >/dev/null
      docker start "$LIVE_APP" >/dev/null
      if wait_healthy "${OLD_HEALTH_URL:-http://127.0.0.1:$PUBLIC_PORT}"; then echo "!! old stack is answering again" >&2
      else echo "!! old stack started but not healthy yet – check: docker logs $LIVE_APP" >&2; fi
    }
    on_exit() { local rc=$?; if (( rc != 0 )) && [[ "$PHASE" != public ]]; then restore_live; fi; exit "$rc"; }
    trap on_exit EXIT
    trap 'exit 130' INT TERM

    log "DOWNTIME START – stop live app (no new uploads/comments)"
    docker update --restart=no "$LIVE_APP" "$LIVE_WORKER" >/dev/null
    docker stop -t 30 "$LIVE_APP" >/dev/null

    log "Drain live queues: waiting/active must reach 0 (max 5 min), else abort"
    drained=no
    for _ in $(seq 1 60); do
      COUNTS=$(docker exec -e REDISCLI_AUTH="$LIVE_REDIS_PW" "$LIVE_REDIS" sh -ec '
        redis-cli ping | grep -q PONG
        busy=0; delayed=0; repeat=0
        for k in $(redis-cli --scan --pattern "bull:*"); do
          case "$k" in
            *:wait|*:active|*:paused) busy=$((busy + $(redis-cli llen "$k"))) ;;
            *:prioritized) busy=$((busy + $(redis-cli zcard "$k"))) ;;
            *:delayed) delayed=$((delayed + $(redis-cli zcard "$k"))) ;;
            *:repeat) repeat=$((repeat + $(redis-cli zcard "$k"))) ;;
          esac
        done
        echo "$busy $delayed $repeat"') || die "cannot read live queues"
      [[ "$COUNTS" =~ ^[0-9]+\ [0-9]+\ [0-9]+$ ]] || die "unexpected queue counts: $COUNTS"
      read -r BUSY DELAYED REPEAT <<<"$COUNTS"
      # delayed entries beyond the repeat schedules are real jobs waiting to run
      if [[ "$BUSY" == 0 && "$DELAYED" -le "$REPEAT" ]]; then drained=yes; break; fi
      echo "queues busy=$BUSY delayed=$DELAYED (repeat schedules=$REPEAT)"; sleep 5
    done
    [[ "$drained" == yes ]] || die "live queues did not drain – aborting cutover"
    docker stop -t 60 "$LIVE_WORKER" >/dev/null
    fail_at after_stop

    log "Final dump of live"
    DUMP="$BACKUPS/cutover-$STAMP.dump"; dump_live "$DUMP"
    log "Uploads delta"
    docker run --rm -v "$LIVE_UPLOADS":/from:ro -v "${PROD_PROJECT}_uploads":/to frameback-rsync:local \
      sh -c 'rsync -a --delete /from/ /to/ && du -sh /to'

    log "Frameback database"
    PHASE=new
    prod up -d --wait --wait-timeout 180 postgres redis
    prod exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qc "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"'
    prod exec -T postgres sh -c 'pg_restore --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$DUMP"
    [[ "$(prod exec -T -e REDISCLI_AUTH="$PROD_REDIS_PW" redis redis-cli FLUSHALL | tr -d '\r')" == OK ]] || die "redis flush failed"

    log "Start Frameback app on 127.0.0.1:$CHECK_PORT only (not public, no worker) for the checks"
    APP_PORT="127.0.0.1:$CHECK_PORT" prod up -d --no-deps app
    wait_healthy "http://127.0.0.1:$CHECK_PORT" || die "frameback app not healthy"
    fail_at before_checks
    log "Check report"
    LIVE_PG_CONTAINER="$LIVE_PG" PROJECT="$PROD_PROJECT" ENV_FILE="$ENV_FILE" REPORT_MODE=production \
      COMPOSE_ARGS="-f $REPO_DIR/deploy/prod/docker-compose.yml" \
      "$REPO_DIR/scripts/staging/report.sh"
    log "Smoke tests"
    smoke "http://127.0.0.1:$CHECK_PORT"

    log "Go public on port $PUBLIC_PORT, start worker"
    # From the moment the port is public clients may write: no automatic rollback any more
    PHASE=public
    trap - EXIT INT TERM
    APP_PORT="$PUBLIC_PORT" prod up -d --no-deps app
    if ! wait_healthy "http://127.0.0.1:$PUBLIC_PORT"; then
      echo "!! Frameback is not answering on $PUBLIC_PORT. Check: docker compose -p $PROD_PROJECT logs app" >&2
      echo "!! To return to the old stack: $0 rollback --yes" >&2
      exit 1
    fi
    prod up -d --no-deps worker
    log "DOWNTIME END – Frameback is live. Live dump: $DUMP. Old stack stopped (restart=no), not removed."
    echo "From now on clients write into Frameback: no automatic rollback. Manual: $0 rollback --yes (loses changes since now)."
    ;;

  rollback)
    need_yes "$@"
    exec 9>"$PROD_DIR/.cutover.lock"; flock -n 9 || die "another cutover/rollback is running"
    echo "Rolling back: stop Frameback app/worker, start old ViTransfer app/worker."
    echo "Comments/decisions made in Frameback since the cutover are NOT carried back."
    prod stop -t 30 app worker
    ! frameback_active || die "Frameback app/worker still running (or state unknown) – not starting the old stack"
    for id in $(prod ps -a -q app worker); do docker update --restart=no "$id" >/dev/null; done
    POL_APP=unless-stopped POL_WORKER=unless-stopped WORKER_WAS_RUNNING=true
    [[ -f "$PROD_DIR/.live-restart-policies" ]] && source "$PROD_DIR/.live-restart-policies"
    docker update --restart="$POL_APP" "$LIVE_APP" >/dev/null; docker update --restart="$POL_WORKER" "$LIVE_WORKER" >/dev/null
    [[ "$WORKER_WAS_RUNNING" == true ]] && docker start "$LIVE_WORKER" >/dev/null
    docker start "$LIVE_APP" >/dev/null
    wait_healthy "${OLD_HEALTH_URL:-http://127.0.0.1:4324}" || die "old app started but not healthy – check docker logs $LIVE_APP"
    log "Old stack running again"
    ;;

  *)
    sed -n '2,15p' "$0"; exit 1
    ;;
esac
