#!/usr/bin/env bash
# Run the staging check report (scripts/staging/report.ts) inside the staging network.
# Reads live row counts read-only for comparison.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE_DIR="${STAGE_DIR:-~/vitransfer-next}"
PROJECT="vitransfer-next"
LIVE_PG_CONTAINER="${LIVE_PG_CONTAINER:-vitransfer-postgres}"
compose() { docker compose -p "$PROJECT" --env-file "$STAGE_DIR/.env" -f "$REPO_DIR/deploy/next/docker-compose.yml" "$@"; }

TABLES='Project Video Comment VideoAsset PhotoAlbum Photo User ProjectRecipient ClientCompany ProjectUpload'
SQL="SELECT json_object_agg(t, n) FROM ("
sep=""
for t in $TABLES; do SQL+="$sep SELECT '$t' AS t, (SELECT count(*) FROM \"$t\") AS n"; sep=" UNION ALL"; done
SQL+=") x;"
LIVE_COUNTS="$(printf '%s\n' "$SQL" | docker exec -i "$LIVE_PG_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA')"

compose run --rm --no-deps -T \
  -v "$REPO_DIR/scripts/staging:/report:ro" \
  -e LIVE_COUNTS_JSON="$LIVE_COUNTS" \
  --entrypoint "" app sh -c 'cp /report/report.ts /app/.staging-report.ts && cd /app && npx tsx .staging-report.ts'
