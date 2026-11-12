#!/usr/bin/env bash
# Restore a backup made by backup.sh. Overwrites current data!
# Usage: infra/scripts/restore.sh backups/mongo-XXXX.archive.gz backups/media-XXXX.tar.gz
set -euo pipefail
cd "$(dirname "$0")/../.."
MONGO_ARCHIVE="$1"; MEDIA_TAR="$2"
COMPOSE=(docker compose -f infra/docker-compose.yml --env-file infra/.env)
# shellcheck disable=SC1091
set -a; source infra/.env; set +a

read -r -p "This replaces the current database and media. Type RESTORE to continue: " ok
[ "$ok" = "RESTORE" ] || { echo "Aborted"; exit 1; }

"${COMPOSE[@]}" exec -T mongo mongorestore --quiet --archive --gzip --drop \
  --username "$MONGO_ROOT_USER" --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  < "$MONGO_ARCHIVE"
docker run --rm -v tasks_media-data:/data -v "$(cd "$(dirname "$MEDIA_TAR")" && pwd)":/in:ro alpine \
  sh -c "rm -rf /data/* && tar xzf /in/$(basename "$MEDIA_TAR") -C /data && chown -R 10001:10001 /data"
echo "Restored. Restart the api: make restart"
