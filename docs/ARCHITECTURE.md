# Architecture

```
 phone (installed PWA "Tasks")                         host machine on the LAN (Docker Compose)
┌──────────────────────────────┐   HTTPS / WSS    ┌──────────┐   ┌────────────────────┐   ┌─────────┐
│ React UI  ── zustand stores  │ ───────────────▶ │  Caddy   │──▶│ api (FastAPI, 1 w) │──▶│ MongoDB │
│ services/  (controller,      │  <sub>.duckdns   │ TLS +    │   │ relay + directory  │   └─────────┘
│            media, push, …)   │  → private IP    │ PWA files│   │ jobs, Web Push ────┼──▶ push service
│ lib/crypto (noble + WebCrypto)│                 └──────────┘   │ media blobs (vol)  │    (internet)
│ IndexedDB: decoy + vault     │                                 └────────────────────┘
│ service worker: shell + push │
└──────────────────────────────┘
```

The server is a **relay and directory**. It never sees plaintext: messages, media, thumbnails and
file keys are encrypted on the client. It knows metadata (who talks to whom, when, sizes).

## Repository layout

| Path | What |
|---|---|
| `frontend/` | TypeScript + React + Vite PWA |
| `backend/` | Python FastAPI service (see `backend/README.md`) |
| `infra/` | Docker Compose, Caddy image, `.env.example`, ops scripts |
| `docs/PROTOCOL.md` | Wire contract between the two (single source of truth) |

### Frontend layers

```
features/*  (screens)        ── read state from state/*, call services/*
state/      (zustand)        ── decrypted, in-memory only; reset() on lock
services/   (use cases)      ── session (unlock/lock), controller (messaging, friends), media, push, backup, account
lib/        (pure building blocks, no React)
   crypto/  code, identity, vault, aead, message, media
   storage/ IndexedDB schema, decoy tasks, SecureStore (encrypted records)
   api/     REST client, WebSocket client
   media/   thumbnails, voice recording/transcoding
sw.ts       service worker
```

`ChatController` is the unlocked session: it is created by `attemptUnlock()` and destroyed by
`lock()`. Only it holds private keys. When it is gone, no key material or plaintext remains in JS state.

### Backend layers

`api/routes` (HTTP/WS adapters) → `services` (business rules: friendship enforcement, rate limits,
queue, presence) → `repositories` (Mongo access) → `db`. Wiring lives in `app/container.py`.
Background jobs (`app/jobs`) purge delivered/expired queue items, expire media by TTL, clean dead
push subscriptions, prune limiter state.

The API runs **one worker** by design: presence and live socket fan-out are in-process.

## Cryptography

| Purpose | Algorithm | Notes |
|---|---|---|
| Identity / signatures | Ed25519 (`@noble/curves`) | WebCrypto Ed25519/X25519 is missing on iOS Safari 16.4, so the audited pure-JS noble library is used instead of libsodium (smaller, no WASM). |
| Key agreement | X25519 → HKDF-SHA256 | Per-friendship AES-256-GCM key; salt = both codes sorted. |
| User code | SHA-256(identity pubkey), 60 bits, base32 w/o `0 1 I O` | Bound to the key, so it cannot be spoofed. |
| Messages | AES-256-GCM, random 96-bit IV | AAD = `lanchat-msg-v1|id|from|to`. |
| Media | AES-256-GCM per chunk, fresh file key | IV = 8 random bytes ‖ chunk index; AAD binds blob id, index, count (no reordering/truncation). |
| Vault | PBKDF2-SHA256 (600 000 it.) wraps a random 256-bit key | No password hash stored; correctness = GCM tag verifies. |
| Local records | AES-256-GCM under HKDF(vault key) | AAD = store\|record-id; record ids/indexes are HMACs so codes are not visible in IndexedDB. |

**Sender authentication — chosen approach: AEAD binding.** Only the two friends can derive the
friendship key, and `from|to|id` is bound as AAD. A ciphertext that decrypts for `from=peer,to=me`
must therefore come from the peer (I didn't make it, and nobody else has the key). Per-message
signatures would add cost without extra guarantees for 1:1 chats. Group chats would need signatures.

**Key trust.** Friend requests and acceptances are Ed25519-signed statements that include the
signer's public keys and a timestamp. Clients re-verify every statement and the code↔key binding
from `GET /api/friends`; a contact's keys are pinned locally on first acceptance and never
overwritten. The safety number (contact info screen) lets people verify in person.

**No forward secrecy** in v1 (static ECDH). See spec §15.

## Disguise and password gate

* Manifest, title, icon, IndexedDB name and notifications all say "Tasks".
* Default screen is a working, unencrypted to-do list seeded with a fixed set of tasks.
* Long-press on the "Tasks" title opens a generic lock screen.
* Wrong password → the same task list, no error. Both paths do the same KDF + unwrap + HKDF work
  and are padded to the same floor (`UNLOCK_FLOOR_MS`) before the screen changes; the slower
  "open vault" work happens after the transition. Covered by `frontend/src/services/session.test.ts`.
* Auto-lock on `visibilitychange`/`pagehide` and after idle (default 2 min). Locking stops the
  socket, zeroes private keys, clears all decrypted state and revokes media object URLs.
  The native iOS photo picker hides the page, so it is temporarily exempted.

## Messaging reliability

1. Client generates the message id, stores the message locally (`sending`) and in an encrypted outbox.
2. `send` over WSS → server checks friendship/blocks/size, stores the envelope, replies `sent`.
3. Recipient online → live `item`; otherwise Web Push with an opaque `ref`.
4. Recipient decrypts, stores, `ack`s → server deletes the envelope, queues `delivered` to the sender.
5. Reconnect (exponential backoff + jitter) → `sync` pages + outbox flush; duplicates are dropped by id
   on both server and client.

## Push

The server sends `{"ref": "<random>"}` only to subscriptions of users with **no** open socket.
The service worker shows "Tasks — "<random open decoy task>" is due today." (falls back to
"You have a task pending."; tag `tasks`). It reads only the plaintext decoy list. The task list shows
cosmetic due dates that are never stored (random per page load, or the date picked when adding);
after a notification tap, the task it named shows as due today. Tapping opens the
**task list** (deliberate deviation from spec F9, which opened the lock screen: the owner prefers the
disguise screen). The ref is kept in memory; when the user unlocks via the usual long-press, the
client syncs, maps ref → conversation from its encrypted ref table, and opens it. Wrong password or
cancelling the lock screen discards the ref.
