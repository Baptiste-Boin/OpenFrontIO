#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=/srv/openfront
[[ $(id -u) == 0 ]] || exit 1
export RELEASE_SHA=$(cat "$root/current-sha")
exec 9>"$root/backup.lock"
flock -n 9 || exit 1
mkdir -p "$root/backups"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$root/backups/openfront-$stamp.sql.gz"
docker compose --project-name openfront --env-file "$root/.env" --file "$root/current/deploy/vps/compose.yml" exec -T postgres pg_dump -U openfront -d openfront --no-owner --no-acl | gzip > "$target.partial"
gzip -t "$target.partial"
mv "$target.partial" "$target"
# Only our own completed SQL dumps are subject to retention.
find "$root/backups" -maxdepth 1 -type f -name 'openfront-*.sql.gz' -mtime +14 -delete
printf 'OpenFront PostgreSQL backup complete: %s\n' "$stamp"
