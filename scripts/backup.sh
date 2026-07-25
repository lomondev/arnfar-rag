#!/usr/bin/env bash
# Arnfar AI — database backup.
#
#   ./scripts/backup.sh            dump the live DB to backups/, prune old ones
#   ./scripts/backup.sh restore <file> [dbname]
#                                  restore a dump into a NEW scratch database
#                                  (never the live one) for inspection/recovery
#
# Written after the 2026-07-22 wipe: the only thing that saved the corpus was a
# 9-day-old manual dump. Run this nightly (cron) or before anything destructive:
#   0 2 * * * /home/arnfar/Desktop/arnfarlab/Arnfar-RAG/scripts/backup.sh >/dev/null 2>&1
#
# Uses the HOST pg_dump/pg_restore (PG18 client → PG16 container server is fine;
# note a PG18-made dump canNOT be read by the container's PG16 pg_restore — always
# restore with the host tools, like this script does).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

set -a; source .env 2>/dev/null || true; set +a
: "${POSTGRES_HOST:=localhost}"
: "${POSTGRES_PORT:=5433}"
: "${POSTGRES_USER:=arnfar}"
: "${POSTGRES_DB:=arnfar}"
export PGPASSWORD="${POSTGRES_PASSWORD:-change-me-locally}"

KEEP=14
DIR="$ROOT/backups"
mkdir -p "$DIR"

case "${1:-dump}" in
  dump)
    # Disk guard — the 2026-07-25 incident: a full disk crashed every container and a
    # cleanup prune then deleted them. Warn loudly at 10G, refuse the dump below 2G
    # (writing a dump onto a full disk makes the outage worse, not better).
    free_kb=$(df -k --output=avail "$DIR" | tail -1 | tr -d ' ')
    if (( free_kb < 2 * 1024 * 1024 )); then
      echo "REFUSING BACKUP: <2G free on $(df -h --output=target "$DIR" | tail -1 | tr -d ' ') — free space first" >&2
      exit 1
    elif (( free_kb < 10 * 1024 * 1024 )); then
      echo "WARNING: low disk — $(df -h --output=avail "$DIR" | tail -1 | tr -d ' ') free. Clean up soon (caches, old models, old dumps)." >&2
    fi
    out="$DIR/arnfar-$(date +%Y%m%d-%H%M%S).dump"
    pg_dump -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --format=custom --file="$out"
    echo "backed up → $out ($(du -h "$out" | cut -f1))"
    # Prune: keep the newest $KEEP auto-dumps (arnfar-*.dump); never touch other files.
    ls -1t "$DIR"/arnfar-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
      rm -f "$old" && echo "pruned $old"
    done
    ;;
  restore)
    file="${2:?usage: backup.sh restore <file> [dbname]}"
    db="${3:-arnfar_recovery}"
    if [[ "$db" == "$POSTGRES_DB" ]]; then
      echo "refusing to restore over the live database '$POSTGRES_DB' — restore to a scratch db, inspect, then copy tables over deliberately" >&2
      exit 1
    fi
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
      -tAc "drop database if exists $db; create database $db;"
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$db" \
      -tAc "create extension if not exists vector; create extension if not exists pg_trgm;"
    pg_restore -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$db" \
      --no-owner --no-privileges "$file" || true
    echo "restored into scratch db '$db' — inspect with: psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -d $db"
    ;;
  *)
    echo "usage: $0 [dump|restore <file> [dbname]]" >&2
    exit 1
    ;;
esac
