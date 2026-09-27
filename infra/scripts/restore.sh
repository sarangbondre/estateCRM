#!/usr/bin/env bash
# Restores a pilot backup (data-hosting §4, runbook docs/runbooks/restore.md).
# Usage: restore.sh <stamp|latest> <target-database-url> [schema ...]
# Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BACKUP_PASSPHRASE.
# Default target is a scratch/local database. Restoring over a live environment is a documented, manual decision.
set -euo pipefail
: "${SUPABASE_URL:?}" "${SUPABASE_SERVICE_ROLE_KEY:?}" "${BACKUP_PASSPHRASE:?}"
STAMP="${1:?stamp or latest}"
TARGET="${2:?target database url}"
shift 2
SCHEMAS=("$@")
[[ ${#SCHEMAS[@]} -eq 0 ]] && SCHEMAS=(web intake records journeys crm_engine listings insight pgmq)
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
AUTH=(-H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

if [[ "$STAMP" == latest ]]; then
  STAMP=$(curl -fsS -X POST "$SUPABASE_URL/storage/v1/object/list/backups" "${AUTH[@]}" -H "Content-Type: application/json" \
    -d '{"prefix":"","limit":1000,"sortBy":{"column":"name","order":"desc"}}' | jq -r '[.[].name] | sort | last')
fi
echo "restoring backup $STAMP into target"
for s in "${SCHEMAS[@]}"; do
  curl -fsS "${AUTH[@]}" "$SUPABASE_URL/storage/v1/object/backups/$STAMP/$s.dump.gpg" -o "$WORK/$s.dump.gpg"
  gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" --decrypt --output "$WORK/$s.dump" "$WORK/$s.dump.gpg"
  if [[ "$s" == pgmq ]]; then
    # Pending messages only (NDJSON): the target's migrations already created the queues. Existing messages are replaced.
    psql "$TARGET" -v ON_ERROR_STOP=1 -q <<SQL
begin;
create temp table restore_q (line jsonb) on commit drop;
\\copy restore_q (line) from '$WORK/$s.dump' with (format csv, quote e'\\x01', delimiter e'\\x02')
select pgmq.purge_queue(queue_name) from pgmq.list_queues();
select count(*) as requeued from restore_q r
  cross join lateral pgmq.send(r.line->>'queue', r.line->'message') as sent
  where exists (select 1 from pgmq.list_queues() where queue_name = r.line->>'queue');
commit;
SQL
  else
    # The target must have the platform bootstrap applied (roles <svc>_owner/_svc exist): owners and grants are kept.
    pg_restore --dbname="$TARGET" --clean --if-exists --single-transaction "$WORK/$s.dump"
  fi
  echo "restored $s"
done
