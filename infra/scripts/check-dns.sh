#!/usr/bin/env bash
# Diagnose DNS rebinding protection: compares what a public resolver and your router return.
# Run on a machine connected to the same Wi-Fi as the phones.
set -uo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
set -a; source infra/.env; set +a
HOST="${DUCKDNS_SUBDOMAIN}.duckdns.org"
q() { if command -v dig >/dev/null; then dig +short "$HOST" ${1:+@$1} | tail -n1; else nslookup "$HOST" ${1:-} 2>/dev/null | awk '/^Address: /{a=$2} END{print a}'; fi; }
PUB="$(q 1.1.1.1)"; LOCAL="$(q)"
echo "Public DNS (1.1.1.1): ${PUB:-<none>}"
echo "Your network's DNS:   ${LOCAL:-<none>}"
if [ -z "$PUB" ]; then echo "✗ DuckDNS has no A record. Run infra/scripts/duckdns-set-ip.sh"; exit 1; fi
if [ "$PUB" != "$LOCAL" ]; then
  echo "✗ Your router blocks or rewrites private answers (DNS rebinding protection)."
  echo "  Whitelist '$HOST' (or duckdns.org) in the router's rebind settings. See README → Troubleshooting."
  exit 1
fi
echo "✓ DNS OK. Testing HTTPS…"
curl -fsS -o /dev/null -w "HTTP %{http_code}\n" "https://$HOST/api/health" || echo "✗ HTTPS failed (is the stack running? firewall port 443?)"
