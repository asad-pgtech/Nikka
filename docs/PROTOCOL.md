# Wire Protocol (v1)

Single source of truth for the contract between `frontend/` and `backend/`.
Any change here must be applied to both sides.

## Conventions

- All binary values in JSON are **base64url without padding** ("b64").
- User **codes** on the wire are normalized: 12 uppercase chars, no dashes.
  Clients display them as `XXXX-XXXX-XXXX`. Normalization = uppercase + strip everything that is not `[A-Z0-9]`.
- Timestamps are integer **milliseconds since epoch** (`ts`).
- Authenticated REST calls send `Authorization: Bearer <token>`.
- Error responses: `{"detail": {"code": "<machine_code>", "message": "<human>"}}` with a matching HTTP status.
- All REST paths are prefixed with `/api`. Caddy proxies `/api/*` to the API container.

## Keys and code derivation

- Identity key: Ed25519 (32-byte public key). Agreement key: X25519 (32-byte public key).
- **Code** = first 60 bits of `SHA-256(identity_public_key)`, big-endian, as 12 chars of 5 bits each, alphabet
  `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no `0 1 I O`).
  - Test vectors: identity key bytes `00 01 02 … 1f` → `EE8WUCD8SJTQ`; 32 zero bytes → `ETN9PDHSECYR`.

## Signed statements (Ed25519, UTF-8 strings, `|`-joined)

| Purpose | Message signed |
|---|---|
| Bind agreement key | bytes of `"lanchat-akey-v1:"` followed by the raw 32-byte agreement public key |
| Auth (REST + WS) | `lanchat-auth-v1:{nonce}` (nonce is the b64 string as issued) |
| Friend request | `lanchat-freq-v1\|{from}\|{to}\|{from_identity_key_b64}\|{from_agreement_key_b64}\|{ts}` |
| Friend accept | `lanchat-facc-v1\|{from}\|{to}\|{from_identity_key_b64}\|{from_agreement_key_b64}\|{ts}` |

`from` is the signer. For accept, `from` is the accepter and `to` is the original requester.
Server verifies `ts` is within ±10 minutes of server time. Clients re-verify signatures before trusting keys.

## Message encryption (client only; server treats `payload` as opaque)

- Friendship key: `HKDF-SHA256(ikm = X25519(my_priv, peer_pub), salt = UTF-8("{lowerCode}|{higherCode}") sorted lexicographically, info = "lanchat-friend-v1")` → AES-GCM-256.
- `payload` = b64(`iv(12) || ciphertext+tag`), AAD = UTF-8 `lanchat-msg-v1|{msg_id}|{from}|{to}`.
- Sender authenticity: AEAD binding. Only the two friends hold the key, and the direction (`from|to`) is bound in AAD, so a recipient knows any valid message addressed to it with `from=peer` was produced by the peer. See `docs/ARCHITECTURE.md`.
- Plaintext is JSON: `{"t":"text","body":str,"ts":int,"reply_to"?:str}`, `{"t":"media","ts":int,"media":{...},"caption"?:str,"reply_to"?:str}`, `{"t":"delete","ts":int,"target":msg_id}`,
  `{"t":"profile","ts":int,"avatar":str|null}` (profile picture as a `data:image/jpeg;base64,…` URL ≤ 64 KB, or `null` to
  remove it; receivers keep the one with the highest `ts`; sent with `silent:true`, never shown in the chat).
  `{"t":"nickname","ts":int,"target":CODE,"name":str|null}` (chat nickname for `target`, which must be the sender or
  the recipient; 1–40 chars, `null` clears it; both phones show it; receivers keep the highest `ts` per target and
  show a local notice line; sent with `silent:true`).
  `{"t":"react","ts":int,"target":msg_id,"emoji":str|null}` (sender's emoji reaction to message `target`, sent or
  received; one per person per message, `null` removes it; receivers keep the highest `ts` per sender and message,
  ignore unknown/deleted targets and non-emoji values; sent with `silent:true`, never shown as its own message).

## Media encryption

- Fresh random 256-bit file key per file. Plaintext split into chunks of `chunk_bytes` (from `/api/config`).
- Chunk `i` iv = `base_iv(8 random bytes) || uint32_be(i)`; AAD = UTF-8 `lanchat-media-v1|{blob_id}|{i}|{chunk_count}`.
- Uploaded chunk body = ciphertext+tag (≤ `chunk_bytes + 16`).

---

## REST endpoints

### Public
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/api/health` | – | `{"status":"ok"}` |
| GET | `/api/config` | – | `{"max_file_bytes","chunk_bytes","max_payload_bytes","autolock_default_seconds","media_ttl_days","vapid_public_key"}` (`vapid_public_key` b64 uncompressed P-256 point, or `null`) |
| POST | `/api/register` | `{"code","display_name","username"?,"identity_key","agreement_key","agreement_key_sig","discoverable":bool}` | `201 {"code"}`. Server checks code derivation + sig. Same code with same keys → `200` (idempotent). Same code, different keys → `409 code_taken`. Username in use → `409 username_taken`. |
| POST | `/api/auth/challenge` | `{"code"}` | `{"nonce","expires_at"}` (nonce valid 60 s, single use) |
| POST | `/api/auth/session` | `{"code","nonce","signature"}` | `{"token","expires_at"}` |

`display_name`: 1–40 chars after trim.

### Authenticated
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/me` | – | `{"code","display_name","username","discoverable","show_last_seen"}` (`username` null until chosen) |
| PATCH | `/api/me` | `{"display_name"?,"username"?,"discoverable"?,"show_last_seen"?}` | same as GET. Username in use → `409 username_taken`. |
| DELETE | `/api/me` | – | `204`, removes user, friendships, queue, media, push subs |
| GET | `/api/users/{query}` | – | `PublicUser` = `{"code","display_name","username","identity_key","agreement_key","agreement_key_sig"}`; `404 not_found` if missing **or** a block exists either way. Rate-limited (`429 rate_limited`). `query` is an exact code, or an exact username (`name` or `@name`); a bare query that is a valid code is tried as a code first. |
| GET | `/api/friends` | – | `{"friends":[Friend]}` |
| POST | `/api/friends/request` | `{"to","ts","signature"}` | `201 {"status":"pending"}`; errors `404 not_found`, `409 already_friends`, `409 already_pending`, `409 incoming_pending`, `429 cooldown`, `429 daily_cap`, `400 self` |
| POST | `/api/friends/{code}/accept` | `{"ts","signature"}` | `200 {"status":"accepted"}` (only recipient of a pending request) |
| POST | `/api/friends/{code}/decline` | – | `200 {"status":"declined"}` (recipient; starts cooldown for requester) |
| POST | `/api/friends/{code}/cancel` | – | `200 {"status":"cancelled"}` (requester of a pending request; removes it) |
| POST | `/api/friends/{code}/block` | – | `200 {"status":"blocked"}` (works for any existing user) |
| POST | `/api/friends/{code}/unblock` | – | `200 {"status":"none"}`; relationship is removed when no block remains |
| POST | `/api/media` | `{"to","size","chunk_count"}` (`size` = ciphertext bytes) | `201 {"blob_id","chunk_bytes"}`; `403 not_friends`, `413 too_large`, `400 invalid` if `chunk_count` does not fit `size` |
| PUT | `/api/media/{blob_id}/chunks/{index}` | raw bytes (`application/octet-stream`) | `204` (uploader only, idempotent) |
| GET | `/api/media/{blob_id}` | – | `{"blob_id","size","chunk_count","received":[int],"complete":bool}` (uploader or recipient) |
| POST | `/api/media/{blob_id}/complete` | – | `200 {"complete":true}` once all chunks present, else `409 incomplete` |
| GET | `/api/media/{blob_id}/chunks/{index}` | – | raw bytes (recipient or uploader, only when complete) |
| POST | `/api/media/{blob_id}/downloaded` | – | `204` (recipient only) → blob deleted |
| POST | `/api/push/subscribe` | `{"endpoint","keys":{"p256dh","auth"}}` | `204` (upsert by endpoint) |
| DELETE | `/api/push/subscribe` | `{"endpoint"}` | `204` |

`Friend`:
```json
{
  "code": "…", "display_name": "…",
  "identity_key": "b64", "agreement_key": "b64", "agreement_key_sig": "b64",
  "status": "pending" | "accepted" | "declined" | "blocked",
  "direction": "incoming" | "outgoing",
  "blocked_by_me": false,
  "request_ts": 0, "request_sig": "b64",
  "accept_ts": 0 | null, "accept_sig": "b64" | null,
  "updated_at": 0
}
```
`request_ts`/`request_sig` are `null` for a block-only relationship (no request was ever made).
Visibility rules: declined relationships are visible only to the requester (so the UI can show "declined"); a relationship blocked only by the peer is not returned at all; `blocked` entries returned only when `blocked_by_me`.

---

## WebSocket: `wss://<host>/api/ws`

Every frame is a JSON text frame `{"type": …}`. Max inbound frame = `max_payload_bytes + 4096`.

### Handshake
1. S→C `{"type":"challenge","nonce"}`
2. C→S `{"type":"auth","code","signature"}` (sign `lanchat-auth-v1:{nonce}`) — must arrive within 10 s.
3. S→C `{"type":"ready","token","expires_at","server_time"}` or `{"type":"error","code":"auth_failed"}` then close `4401`.

Nothing else is accepted before `ready`.

### Queue item
```json
{"qid":"srv-id","kind":"msg"|"delivered"|"read","from":"CODE","ts":0,
 "msg_id":"…"?, "msg_ids":["…"]?, "payload":"b64"?, "ref":"b64"?}
```
- `msg`: `msg_id`, `payload`, `ref` (opaque random ref also used in push notifications).
- `delivered`: `msg_id` — the peer's device received your message.
- `read`: `msg_ids` — the peer read these messages.

### Client → Server
| type | fields | effect |
|---|---|---|
| `sync` | – | server replies `{"type":"sync","items":[Item],"more":bool}` (oldest first, ≤ 200). Client repeats while `more`; the server keeps a per-connection cursor so pages never repeat. Unacked items are re-sent on the next connection. |
| `send` | `id` (1–64 chars `[A-Za-z0-9_-]`), `to`, `payload`, `silent`?:bool | Enforces friendship + size. Stores queue item; replies `{"type":"sent","id","ts"}`. Idempotent per (`to`,`from`,`id`) — scoping by sender stops one user squatting another's id. Online recipient gets `{"type":"item","item"}`; otherwise a Web Push is sent unless `silent` is `true` (used for profile updates). |
| `ack` | `qids:[…]` | Deletes acked items addressed to the caller. For each acked `msg` a `delivered` item is queued to the sender (live-delivered if online, never pushed). |
| `read` | `to`, `ids:[msg_id…]` (≤ 200) | Queues a `read` item to `to` (no push). |
| `typing` | `to`, `active:bool` | Forwarded live as `{"type":"typing","from","active"}` if friends and online; dropped otherwise. |
| `ping` | – | `{"type":"pong"}` |

### Server → Client
| type | fields |
|---|---|
| `item` | `item` |
| `sent` | `id`, `ts` |
| `typing` | `from`, `active` |
| `presence` | `users:[{"code","display_name","friend":bool}]` — online, discoverable users (excluding self and anyone with a block either way). Sent after `ready` and on every change. |
| `friends_changed` | – (hint: refetch `GET /api/friends`) |
| `last_seen` | `code`, `ts` (epoch ms) — an accepted friend closed their last socket. Only sent when both users have `show_last_seen` on (`PATCH /api/me`); `GET /api/friends` carries the same value as `last_seen` (null otherwise). |
| `error` | `code`, `message`, `id`? (the `send` id it relates to). Codes: `not_friends`, `payload_too_large`, `invalid`, `unknown_type`, `rate_limited`. |

Limits: binary frames → `invalid`; oversize frame → `payload_too_large` then close `1009`; ≤ 30 frames/s per socket (burst 60) else `rate_limited`. JSON REST bodies > 64 KB → `413`.

### Push payload
JSON `{"ref":"b64"}` only. The service worker always shows title `Tasks`, body `You have a task pending.`, tag `tasks`.

## Usernames

A username is an optional, editable, unique alias for a user's code. The code stays the identity
(it is bound to the key and used in auth, key agreement and signatures); the username is only a
directory handle. Rules: 3–20 chars of `a-z 0-9 _`, stored lowercase, so uniqueness is
case-insensitive. The client asks new users for one at onboarding and prompts existing users
without one after unlock. Changing it frees the old name immediately.
