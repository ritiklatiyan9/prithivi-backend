#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_PATH="${SCHEMA_PATH:-"$ROOT_DIR/prisma/schema.prisma"}"
FAILED_MIGRATION="20260713080000_add_offer_product_fields"
ROULETTE_MIGRATION="20260724000000_roulette"
DB_URL_EXPLICIT=false

print_usage() {
  cat <<'EOF'
Usage:
  ./scripts/fix-prisma-db.sh [options]

Options:
  -u, --db-url <url>   Use this PostgreSQL URL for migration work.
                        Neon pooled and direct URLs are both supported.
                        If omitted, environment variables or .env are used.
      --schema <path>  Prisma schema path (default: ./prisma/schema.prisma)
  -h, --help           Show this help text.

Environment:
  DATABASE_URL_UNPOOLED  Direct Postgres URL used for Prisma migrations.
  DATABASE_URL           Fallback URL (a Neon pooler URL is supported).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--db-url)
      DATABASE_URL_UNPOOLED="$2"
      DB_URL_EXPLICIT=true
      shift 2
      ;;
    --schema)
      SCHEMA_PATH="$2"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      print_usage
      exit 1
      ;;
  esac
done

ENV_DB_URL="${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}"
FILE_DB_URL=""
if [[ -f "$ROOT_DIR/.env" ]]; then
  FILE_DB_URL="$(node "$ROOT_DIR/scripts/prisma-db-inspect.cjs" database-url "$ROOT_DIR/.env")"
fi
DB_URL="${ENV_DB_URL:-$FILE_DB_URL}"

if [[ -z "${DB_URL:-}" ]]; then
  echo "ERROR: No database URL found."
  echo "Set DATABASE_URL in .env, DATABASE_URL_UNPOOLED, or pass --db-url."
  exit 1
fi

if [[ ! -f "$SCHEMA_PATH" ]]; then
  echo "ERROR: Prisma schema not found at $SCHEMA_PATH"
  exit 1
fi

run_prisma() {
  DATABASE_URL="$DB_URL" \
    PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=1 \
    npx prisma "$@" --schema "$SCHEMA_PATH"
}

run_prisma_sql() {
  local sql="$1"
  printf '%s\n' "$sql" | run_prisma db execute --stdin
}

inspect_db() {
  DATABASE_URL="$DB_URL" node "$ROOT_DIR/scripts/prisma-db-inspect.cjs" "$@"
}

safe_db_target() {
  local url="$1"
  local target

  if [[ "$url" == *"@"* ]]; then
    target="${url##*@}"
    echo "postgresql://${target%%\?*}"
  else
    echo "(database URL hidden)"
  fi
}

check_connection() {
  if inspect_db connection >/dev/null 2>&1; then
    echo "==> Connection OK."
    return 0
  fi
  return 1
}

echo "==> DB target: $(safe_db_target "$DB_URL")"

CONNECTION_OK=true
if ! check_connection; then
  CONNECTION_OK=false
  if [[ "$DB_URL_EXPLICIT" == false && -n "$FILE_DB_URL" && "$FILE_DB_URL" != "$DB_URL" ]]; then
    echo "==> Exported database URL is unavailable; trying DATABASE_URL from .env."
    DB_URL="$FILE_DB_URL"
    echo "==> Fallback DB target: $(safe_db_target "$DB_URL")"
    if check_connection; then
      CONNECTION_OK=true
    fi
  fi
fi

if [[ "$CONNECTION_OK" == false ]]; then
  echo "ERROR: Can't reach the provided DATABASE_URL."
  echo "Use the exact working Neon URL from .env or the Neon dashboard."
  echo "Do not use literal placeholders such as <user>, <password>, or ...."
  echo "If the URL is correct and still fails, run this script from a network that can reach Neon (or Render shell)."
  echo "Both Neon pooler (-pooler hostname) and direct URLs are supported."
  exit 1
fi

echo "==> Checking migration state and required columns..."

MIGRATION_STATE="$(inspect_db migration-state "$FAILED_MIGRATION")"
echo "Migration state: ${MIGRATION_STATE:-unknown}"

OFFERS_COLUMNS_STATUS="$(inspect_db offers-columns)"
echo "Offers columns status: ${OFFERS_COLUMNS_STATUS:-unknown}"

if [[ "$OFFERS_COLUMNS_STATUS" != "READY" ]]; then
  echo "==> Adding missing offer migration columns (idempotent)."
  OFFER_COLS_SQL=$(cat <<'SQL'
ALTER TABLE "offers"
  ADD COLUMN IF NOT EXISTS "isProduct" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "brandLogoUrl" TEXT;
SQL
)
  run_prisma_sql "$OFFER_COLS_SQL"
else
  echo "==> Offer columns already present."
fi

if [[ "${MIGRATION_STATE:-}" != "APPLIED" ]]; then
  echo "==> Marking repaired migration as applied: $FAILED_MIGRATION"
  run_prisma migrate resolve --applied "$FAILED_MIGRATION"
else
  echo "==> Repaired migration is already applied."
fi

ROULETTE_MIGRATION_STATE="$(inspect_db migration-state "$ROULETTE_MIGRATION")"
echo "Roulette migration state: ${ROULETTE_MIGRATION_STATE:-unknown}"

if [[ "$ROULETTE_MIGRATION_STATE" != "APPLIED" ]]; then
  echo "==> Repairing the partially created Roulette base schema."
  ROULETTE_INDEX_SQL=$(cat <<'SQL'
CREATE INDEX IF NOT EXISTS "roulette_rounds_probabilityProfileId_idx"
ON "roulette_rounds"("probabilityProfileId");
SQL
)
  run_prisma_sql "$ROULETTE_INDEX_SQL"

  ROULETTE_SCHEMA_STATUS="$(inspect_db roulette-base-status)"
  if [[ "$ROULETTE_SCHEMA_STATUS" != "READY" ]]; then
    echo "ERROR: The Roulette base schema is incomplete; migration was not marked as applied."
    echo "Inspect it with: node scripts/prisma-db-inspect.cjs roulette-schema"
    exit 1
  fi

  echo "==> Marking repaired migration as applied: $ROULETTE_MIGRATION"
  run_prisma migrate resolve --applied "$ROULETTE_MIGRATION"
else
  echo "==> Roulette base migration is already applied."
fi

echo "==> Running migrate deploy with Prisma advisory locking disabled."
echo "    Make sure another deployment is not migrating this database at the same time."
run_prisma migrate deploy

echo "==> Verifying wallet purchase table exists."
COIN_TABLE="$(inspect_db coin-purchases-table)"
if [[ "$COIN_TABLE" == "READY" ]]; then
  echo "==> Success: public.coin_purchases exists."
else
  echo "ERROR: public.coin_purchases was not created."
  exit 1
fi

echo "==> Running migration status."
run_prisma migrate status
echo "==> Done."
