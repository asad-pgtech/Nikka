# syntax=docker/dockerfile:1
# Reverse proxy + TLS + static PWA in one image.
# Build context is the repository root (see infra/docker-compose.yml).

# ---- 1. Build the PWA ----------------------------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. Caddy with the DuckDNS DNS-01 module ------------------------------------------------------
FROM caddy:2.10-builder AS caddy-build
RUN xcaddy build --with github.com/caddy-dns/duckdns

# ---- 3. Runtime -----------------------------------------------------------------------------------
FROM caddy:2.10
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /web/dist /srv/www
RUN caddy list-modules | grep -q 'dns.providers.duckdns'
