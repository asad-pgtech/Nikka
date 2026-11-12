#!/usr/bin/env bash
# Point <subdomain>.duckdns.org at this host's PRIVATE LAN IP (run once, and again if the IP changes).
# Usage: infra/scripts/duckdns-set-ip.sh [lan-ip]   (auto-detects the IP of the default route)
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
set -a; source infra/.env; set +a
IP="${1:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')}"
[ -n "$IP" ] || { echo "Could not detect LAN IP; pass it as an argument"; exit 1; }
echo "Setting ${DUCKDNS_SUBDOMAIN}.duckdns.org -> $IP"
RES="$(curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=${IP}")"
[ "$RES" = "OK" ] && echo "OK" || { echo "DuckDNS answered: $RES"; exit 1; }
