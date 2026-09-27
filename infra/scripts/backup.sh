#!/usr/bin/env bash
# Nightly pilot backup (data-hosting §4, F-16): pg_dump per service schema + pgmq + platform, encrypted with a
# passphrase, uploaded to the private Supabase Storage bucket `backups` (Mumbai), 14-day retention.
# Env (GitHub Actions secrets): BACKUP_DATABASE_URL (admin, direct connection), SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY (storage upload only), BACKUP_PASSPHRASE. Optional: RETENTION_DAYS (14).
set -euo pipefail
: "${BACKUP_DATABASE_URL:?}" "${SUPABASE_URL:?}" "${SUPABASE_SERVICE_ROLE_KEY:?}" "${BACKUP_PASSPHRASE:?}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
SCHEMAS=(web intake records journeys crm_engine listings insight)
STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

upload() { # $1 local file, $2 object path
  curl -fsS -X POST "$SUPABASE_URL/storage/v1/object/backups/$2" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "x-upsert: false" \
    -H "Content-Type: application/octet-stream" --data-binary "@$1" >/dev/null
}

# Service schemas: complete (objects, owners, grants, data).
# Queues: pgmq queue tables are extension members, which pg_dump skips, so pending messages are exported as NDJSON
# ({queue, message}); the queues themselves come from migrations.
UNION=$(psql "$BACKUP_DATABASE_URL" -Atc "select coalesce(string_agg(format('select %L as queue, message, enqueued_at from pgmq.%I', queue_name, 'q_' || queue_name), ' union all '), 'select null::text as queue, null::jsonb as message, null::timestamptz as enqueued_at where false') from pgmq.list_queues()")
psql "$BACKUP_DATABASE_URL" -Atc "select json_build_object('queue', queue, 'message', message) from ($UNION) t order by enqueued_at" > "$WORK/pgmq.dump"
for s in "${SCHEMAS[@]}" pgmq; do
  if [[ "$s" != pgmq ]]; then
    pg_dump "$BACKUP_DATABASE_URL" --schema="$s" --format=custom --file="$WORK/$s.dump"
  fi
  gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" --symmetric --cipher-algo AES256 \
    --output "$WORK/$s.dump.gpg" "$WORK/$s.dump"
  upload "$WORK/$s.dump.gpg" "$STAMP/$s.dump.gpg"
  echo "backed up $s ($(stat -c%s "$WORK/$s.dump.gpg" 2>/dev/null || stat -f%z "$WORK/$s.dump.gpg") bytes)"
done
printf '{"stamp":"%s","schemas":"%s pgmq"}\n' "$STAMP" "${SCHEMAS[*]}" > "$WORK/manifest.json"
upload "$WORK/manifest.json" "$STAMP/manifest.json"

# Retention: delete backup folders older than RETENTION_DAYS.
CUTOFF="$(date -u -d "-$RETENTION_DAYS days" +%Y-%m-%d 2>/dev/null || date -u -v-"$RETENTION_DAYS"d +%Y-%m-%d)"
curl -fsS -X POST "$SUPABASE_URL/storage/v1/object/list/backups" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d '{"prefix":"","limit":1000}' |
  jq -r '.[].name' | while read -r folder; do
    if [[ "${folder:0:10}" < "$CUTOFF" ]]; then
      files=$(curl -fsS -X POST "$SUPABASE_URL/storage/v1/object/list/backups" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
        -H "Content-Type: application/json" -d "{\"prefix\":\"$folder/\",\"limit\":100}" | jq -c "[.[].name | \"$folder/\" + .]")
      curl -fsS -X DELETE "$SUPABASE_URL/storage/v1/object/backups" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
        -H "Content-Type: application/json" -d "{\"prefixes\":$files}" >/dev/null
      echo "retention: deleted $folder"
    fi
  done
echo "backup $STAMP complete"
