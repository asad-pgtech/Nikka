#!/usr/bin/env bash
# Print a fresh VAPID key pair for infra/.env. Generate ONCE: changing keys invalidates every
# existing push subscription (users must toggle notifications again).
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f infra/docker-compose.yml --env-file infra/.env run --rm --no-deps api python -m app.scripts.gen_vapid
