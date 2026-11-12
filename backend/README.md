# LAN Chat API (backend)

FastAPI relay + directory for the LAN Chat PWA. Implements `../docs/PROTOCOL.md`.
The server never sees plaintext: it stores public keys, friendship records,
opaque encrypted envelopes (until acked) and encrypted media chunks (until
downloaded or TTL).

## Layout

```
app/
  main.py            app factory, lifespan (Mongo, indexes, jobs), error handlers
  container.py       composition root (wires repositories + services)
  core/              config (env), logging, security (codes, Ed25519, tokens), errors
  db/                Mongo client + index creation
  repositories/      one class per collection, persistence only
  services/          business rules: auth, users, friends, messaging, media, push,
                     presence, connections (in-memory WS registry), rate limits
  api/               deps, body-size middleware, routes/ (REST + /api/ws)
  jobs/              periodic maintenance (queue purge, media TTL, push cleanup)
  scripts/gen_vapid  VAPID key generator
tests/               unit + integration tests (real Mongo)
```

Single worker by design: presence and live delivery are in process memory.

## Local development

```bash
uv sync
docker run -d --rm --name lanchat-mongo -p 27017:27017 mongo:7
MONGO_URL=mongodb://localhost:27017 MEDIA_DIR=./.media uv run uvicorn app.main:app --reload
```

Generate VAPID keys (prints `.env` lines):

```bash
uv run python -m app.scripts.gen_vapid
# or, in Docker:
docker compose run --rm api python -m app.scripts.gen_vapid
```

## Configuration

All settings are environment variables (see `app/core/config.py`):
`MONGO_URL`, `MONGO_DB`, `MEDIA_DIR`, `MAX_FILE_MB` (100), `CHUNK_KB` (512),
`MAX_PAYLOAD_KB` (64), `MEDIA_TTL_DAYS` (30), `QUEUE_TTL_DAYS` (30),
`REQUEST_COOLDOWN_HOURS` (24), `REQUEST_DAILY_CAP` (20), `LOOKUP_PER_MINUTE` (30),
`AUTOLOCK_DEFAULT_SECONDS` (120), `SESSION_TTL_MINUTES` (60), `SESSION_SECRET`
(random per process if unset), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT` (`mailto:admin@localhost`), `LOG_LEVEL` (INFO),
`JOB_INTERVAL_SECONDS` (300).

## Tests

Tests need a reachable MongoDB (`TEST_MONGO_URL`, default `mongodb://localhost:27017`);
each test uses a throwaway database that is dropped afterwards. Without Mongo the
suite is skipped with a hint.

```bash
docker run -d --rm --name lanchat-test-mongo -p 27017:27017 mongo:7
uv run pytest
docker stop lanchat-test-mongo
```
