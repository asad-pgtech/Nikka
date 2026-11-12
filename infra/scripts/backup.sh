#!/usr/bin/env bash
# Back up MongoDB (ciphertext + metadata only) and the encrypted media volume.
# Usage: infra/scripts/backup.sh [output-dir]   (default: ./backups)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
COMPOSE=(docker compose -f infra/docker-compose.yml --env-file infra/.env)
mkdir -p "$OUT"

# shellcheck disable=SC1091
set -a; source infra/.env; set +a

echo "→ MongoDB dump"
"${COMPOSE[@]}" exec -T mongo mongodump --quiet --archive --gzip \
  --username "$MONGO_ROOT_USER" --password "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  > "$OUT/mongo-$STAMP.archive.gz"

echo "→ Media volume"
docker run --rm -v tasks_media-data:/data:ro -v "$(pwd)/$OUT":/out alpine \
  tar czf "/out/media-$STAMP.tar.gz" -C /data .

echo "Done: $OUT/mongo-$STAMP.archive.gz  $OUT/media-$STAMP.tar.gz"
