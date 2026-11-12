# Convenience targets. Production stack lives in infra/.
COMPOSE := docker compose -f infra/docker-compose.yml --env-file infra/.env
DEV     := docker compose -f infra/docker-compose.dev.yml

.PHONY: help env up down restart logs ps build vapid backup check-dns duckdns-ip \
        dev-db dev-api dev-web test test-backend test-frontend

help:            ## List targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

env:             ## Create infra/.env from the example
	@test -f infra/.env && echo "infra/.env exists" || (cp infra/.env.example infra/.env && echo "Created infra/.env - edit it now")

up:              ## Build and start the production stack
	$(COMPOSE) up -d --build

down:            ## Stop the stack (volumes are kept)
	$(COMPOSE) down

restart:         ## Restart all services
	$(COMPOSE) restart

logs:            ## Follow logs
	$(COMPOSE) logs -f --tail=100

ps:              ## Service status
	$(COMPOSE) ps

build:           ## Build images without starting
	$(COMPOSE) build

vapid:           ## Generate VAPID keys for Web Push (paste into infra/.env)
	./infra/scripts/gen-vapid.sh

backup:          ## Back up Mongo + media volumes into ./backups
	./infra/scripts/backup.sh

check-dns:       ## Diagnose DuckDNS / router DNS rebinding
	./infra/scripts/check-dns.sh

duckdns-ip:      ## Point the DuckDNS name at this host's LAN IP
	./infra/scripts/duckdns-set-ip.sh

dev-db:          ## Start MongoDB for local development
	$(DEV) up -d

dev-api:         ## Run the API with auto-reload (needs dev-db)
	cd backend && MEDIA_DIR=$${MEDIA_DIR:-./.media} uv run uvicorn app.main:app --reload --port 8000

dev-web:         ## Run the PWA dev server on http://localhost:5173
	cd frontend && npm run dev

test: test-backend test-frontend ## Run all tests

test-backend:    ## Backend tests (needs MongoDB on localhost:27017, e.g. make dev-db)
	cd backend && uv run pytest -q

test-frontend:   ## Frontend unit tests
	cd frontend && npm test
