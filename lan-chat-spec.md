# LAN Chat — Build Specification (v1)

## 1. Summary

Build a private, end-to-end encrypted, realtime chat app delivered as a **Progressive Web App (PWA)**. It runs on iPhone and Android with no App Store or Play Store. The server runs on the owner's own machine on a home/office Wi-Fi. All users connect to it over that same network.

The app is **disguised as a to-do app ("Tasks")**. Chats are hidden behind a password. A wrong password silently shows a decoy task list instead of an error.

**How to use this spec:** build in the milestone order in section 13. If anything here is ambiguous or conflicts with a technical constraint you discover, stop and ask before choosing.

---

## 2. Goals and non-goals

### Goals
- Realtime 1:1 chat between users on the same network.
- Users find each other by a unique code, or by seeing who is online on the network.
- A friend request must be accepted before two users can chat.
- Photos, videos, voice notes/audio, and GIF files can be sent.
- End-to-end encryption: the server never sees message or media content.
- Chat history is stored only on the device, encrypted. Only that device's user can decrypt it, with their password.
- Push notifications that reveal nothing ("You have a task pending").
- Disguise mode with a duress/decoy behavior on wrong password.
- Total running cost of approximately zero.

### Non-goals (v1)
- Group chats, voice/video calls, GIF search (e.g., Giphy).
- Multi-device per user.
- Use from outside the host network.
- Publishing to any app store.
- Forward secrecy / Double Ratchet (see Future work).
- Strong forensic deniability. The disguise targets casual inspection, not forensic analysis.

---

## 3. Deployment context and constraints

- **Host:** the owner's own computer on the LAN. It must stay on, with sleep disabled.
- **Fixed address:** the host gets a fixed LAN IP via a DHCP reservation on the router.
- **Hostname:** a free DuckDNS subdomain whose A record points to the host's **private** LAN IP. No paid domain.
- **HTTPS is mandatory.** Web Crypto, service workers, PWA install, microphone access, and Web Push all require a secure context. Use **Caddy** with the DuckDNS DNS plugin so Let's Encrypt certificates are issued and renewed automatically via the DNS-01 challenge. The host never needs to be exposed to the internet.
- **Internet requirement:** the host needs internet for certificate renewal and for sending push notifications. Phones need internet to resolve the DuckDNS name and to receive pushes. Chat traffic itself stays on the LAN.
- **The origin must never change** after users install the app. Browser storage (keys, history) is bound to the hostname. Document this prominently in the README.
- **Known router issue:** some routers have DNS rebinding protection that blocks public names resolving to private IPs. The README must explain how to diagnose and whitelist.

---

## 4. Tech stack

| Layer | Choice |
|---|---|
| Reverse proxy / TLS | Caddy, custom build with the `caddy-dns/duckdns` module |
| Backend | Python, FastAPI, native WebSockets, async |
| Database | MongoDB (ciphertext and metadata only) |
| Media storage | Encrypted blobs on the host filesystem (mounted volume) |
| Push | Web Push with VAPID keys, sent from the backend using `pywebpush` |
| Frontend | TypeScript, React, Vite, installable PWA (manifest + service worker) |
| Client storage | IndexedDB (via a small wrapper such as `idb`) |
| Crypto | Web Crypto API for AES-GCM, PBKDF2, HKDF, and key wrapping. Use X25519/Ed25519 via Web Crypto where the target browsers support it; otherwise use `libsodium.js` for curve operations. |
| Packaging | Docker Compose (caddy, api, mongo) with restart policies |

**Target browsers:** iOS Safari 16.4+ (installed to the Home Screen) and current Chrome on Android. Desktop browsers should work but are secondary.

---

## 5. Architecture

- Phones load the PWA from the host over HTTPS. They keep a WebSocket (WSS) connection open while the app is in the foreground.
- The server is a **relay and directory**. It handles:
  - registration and the code → public key directory
  - presence (online users)
  - friend-request relay and friendship records
  - a store-and-forward queue for encrypted messages
  - encrypted media blob storage
  - push dispatch
- All message and media encryption and decryption happen **on the client**.
- **Server retention:** a message envelope is deleted from the server once the recipient acknowledges delivery. Media blobs are deleted after the recipient confirms download, or after a configurable TTL (default 30 days), whichever comes first. Long-term history lives only on devices.
- **What the server knows (accepted trade-off):** metadata such as who talks to whom, when, and media sizes. It never learns content.

---

## 6. Security and cryptography model

### 6.1 Identity
- On first run, the client generates:
  - an **identity signing keypair** (Ed25519)
  - a **key-agreement keypair** (X25519)
- Private keys never leave the device unencrypted. They are stored in IndexedDB, encrypted under the vault key (6.2).
- **Unique user code:** derived from a hash of the public identity key, encoded in base32 without ambiguous characters, formatted like `XXXX-XXXX-XXXX`. Because the code is bound to the key, it cannot be spoofed.

### 6.2 Vault and password
- A random 256-bit **vault key** encrypts all local chat data: messages, contacts, private keys, and cached media.
- The vault key is **wrapped** with a key-encryption key derived from the user's password. Use PBKDF2-SHA-256 with at least 600,000 iterations and a random salt. Argon2id via WASM is acceptable if justified.
- **No password hash is stored anywhere.** Correctness is determined only by whether unwrapping succeeds (the AES-GCM authentication check).
- Once unwrapped, the vault key is held in memory as a non-extractable `CryptoKey`.
- On setup, the user must be told that **a forgotten password means permanent loss of chat history**.

### 6.3 Authentication to the server
- Each WebSocket connection authenticates with challenge-response: the server sends a nonce, and the client signs it with the identity key.
- The server verifies the signature against the registered public key and issues a short-lived session token for REST calls such as media upload.

### 6.4 Friendship and message encryption
- **Friend requests:** each request carries the sender's public keys and is signed. On acceptance, both clients store each other's public keys as trusted contacts.
- **Per-friendship key:** derived via X25519 ECDH, then HKDF.
- **Messages:** each is encrypted with AES-GCM under the per-friendship key, using a unique nonce. Sender identity and integrity are verified via signature or AEAD binding; document the chosen approach.
- **Safety number:** optional in v1, but design the data model to support it. It is shown in the contact screen as a short fingerprint or QR so users can verify each other in person.
- **Relay restriction:** the server must refuse to relay messages between users who are not friends, and between users where either has blocked the other.

### 6.5 Media encryption
- The sender encrypts each file client-side with a fresh random key and uploads only ciphertext, chunked.
- The message envelope (itself encrypted) carries the blob ID, file key, MIME type, size, and an encrypted thumbnail or preview.

### 6.6 Hygiene rules
- **Never log** plaintext, keys, passwords, or decrypted metadata, on either client or server.
- Server logs may contain user codes and timestamps only.
- No analytics, no third-party scripts, no external CDNs at runtime. Bundle everything.

---

## 7. Features and acceptance criteria

### F1. Onboarding
- The first visit shows a friendly install guide:
  - iOS: Share → Add to Home Screen.
  - Android: the install prompt.
- If running in an iOS browser tab (not installed), show a banner explaining that notifications and reliable storage require installing.
- The user sets a **display name** and a **password**, with confirmation and a strength hint.
- Keys are generated, the vault is created, the user is registered with the server, and the user's code is shown with a copy button.
- Request persistent storage from the browser.

**Acceptance:** after onboarding, reloading the app shows the Tasks screen and requires the password to reach chats.

### F2. Disguise mode and password gate
- **The whole app presents as "Tasks"**: manifest name, short name, icon, page title, theme, and splash. Nothing on the home screen or in the app switcher mentions chat.
- **Default screen is a functional to-do list (the decoy).**
  - Users can add, check, and delete tasks.
  - Decoy tasks are stored separately from the vault and are deliberately unencrypted, so they look normal.
  - On first run, seed it with a small, plausible, **fixed** set of tasks.
- **Discreet entry to chats:** a non-obvious gesture on the Tasks screen (for example, a long-press on the title) opens the password screen. The password screen looks like an ordinary app lock for a to-do app.
- **Correct password:** unlock the vault. If opened from a notification, go directly to that conversation (F9). Otherwise go to the chat list.
- **Wrong password:** show the decoy task list.
  - No error message, shake, toast, or "try again."
  - The decoy shown is always the same list (consistent across attempts).
  - Timing must be indistinguishable between correct and wrong passwords, since key derivation runs the same way for both.
  - No lockouts or attempt counters. Slow key derivation is the brute-force defense.
- Mistyping the real password also shows the decoy. This is expected behavior; explain it during onboarding.

**Acceptance:** a tester entering wrong passwords repeatedly sees identical decoy content with no visible or timing difference from a normal unlock.

### F3. Auto-lock
- Lock immediately when the app goes to the background (page visibility change), and after a configurable idle timeout (default 2 minutes).
- Locking discards the in-memory vault key, clears decrypted content from state and the DOM, and returns to the Tasks screen.
- No unread badge counts or chat-related app badges.

### F4. People on the network
- When unlocked, show a list of currently online users (connected to the server) with display names.
- Each user has a **"Discoverable on network"** setting, default ON. When OFF, they don't appear in the list but can still be found by exact code.

### F5. Find by code
- Search by exact code, case-insensitive and tolerant of missing dashes.
- Shows the matching user (display name) with a "Send request" action.
- No partial or fuzzy matching. This prevents code enumeration.

### F6. Friend requests
- Users can send, cancel, accept, decline, and block. Unblock is available from contact settings.
- Incoming requests appear in a "Requests" section inside the chat area. Requests can arrive while offline and are delivered on reconnect.
- **Rate-limit** requests: a cooldown on re-requesting the same person after a decline, plus a per-user daily cap. Values are configurable.
- Chatting is impossible until accepted. The server enforces this (6.4).

### F7. Realtime chat (1:1)
- Text messages with client-generated IDs, timestamps, and correct ordering.
- **Reliability:**
  - The server queues messages for offline recipients.
  - The client acknowledges receipt.
  - Retries on reconnect.
  - Duplicates are de-duplicated by message ID.
- **Status:**
  - Message states: sending, sent (server ack), delivered (recipient ack), read.
  - Read receipts can be turned off per user.
  - Typing indicators.
- Automatic WebSocket reconnection with backoff, and a visible "connecting…" state.
- Reply-to-message and delete-for-me.
- Delete-for-everyone is a "should have" if time allows.

### F8. Media
- **Photos:** pick from library or camera. Generate a compressed thumbnail client-side.
- **Videos:** pick or record. Show a poster-frame thumbnail if feasible.
- **Voice notes:** record in-app (hold or tap to record), with duration and playback.
  - Must handle iOS (mp4/aac) and Android (webm/opus) recording formats. Playback must work across platforms; transcode on the client or pick a common format if needed.
- **GIFs:** send as files from the device (no search service). They auto-play in the chat.
- **General audio and files:** allowed, shown as an attachment card.
- **Upload and download:**
  - Chunked and resumable, with progress indicators.
  - A configurable max file size (default 100 MB).
  - Downloaded media is cached in IndexedDB, encrypted under the vault key.

### F9. Push notifications
- An **"Enable notifications"** button triggers the permission request, which must come from a user gesture. Explain the iOS Home Screen requirement.
- Store the push subscription server-side per user. Remove subscriptions that return HTTP 404 or 410.
- Send a push **only when the recipient has no active WebSocket connection**.
- **Notification content:**
  - Title "Tasks", body "You have a task pending."
  - The payload contains only an **opaque, random reference** to the message. No sender name, code, or content.
  - Collapse repeated notifications with a tag.
- **Every push must display a notification.** iOS revokes permission for silent pushes.
- **Tapping the notification:** opens the password screen carrying the reference.
  - On correct password, the client syncs pending messages, finds the conversation containing that message, and opens it.
  - On wrong password, it shows the decoy list.

### F10. Encrypted local history
- All conversations, contacts, and media are stored in IndexedDB, encrypted under the vault key, and decrypted only while unlocked.
- History survives app restarts. The server holds nothing long-term (section 5).

### F11. Settings (inside the unlocked area)
- Display name, own code with QR, discoverable toggle, and read receipts toggle.
- Auto-lock timeout, notifications toggle, and blocked users list.
- Change password: re-wrap the vault key; existing data is not re-encrypted.
- **Wipe all data on this device**, with a strong confirmation.

### F12. Encrypted backup (should have)
- Export the full vault as a single file encrypted with a separate backup passphrase, and import it on a fresh install with the same origin.

---

## 8. Server responsibilities (task level)

### REST
- Health check.
- Registration: code, display name, public keys.
- Session issuance after signature challenge.
- Lookup by exact code.
- Friend request actions.
- Media chunk upload and download, plus download-complete acknowledgment.
- Push subscription save and delete.

### WebSocket events
- Authenticate.
- Presence updates (online list).
- Encrypted message send.
- Delivery ack.
- Read receipt.
- Typing indicator.
- Friend request notifications.
- Sync of queued items on connect.

### Background jobs
- Purge delivered messages.
- Expire media by TTL.
- Clean dead push subscriptions.
- Enforce rate limits.

### Validation
- Enforce payload size limits on all inputs.
- Reject malformed envelopes.
- Enforce friendship and blocking on every relay.

---

## 9. Data model (server, descriptive)

| Collection | Contents |
|---|---|
| **users** | code (unique), display name, identity public key, key-agreement public key, discoverable flag, created time |
| **friendships** | user pair, status (pending / accepted / declined / blocked), requester, timestamps, cooldown info |
| **queued_messages** | message ID, from, to, encrypted envelope, created time, delivered flag |
| **media_blobs** | blob ID, uploader, intended recipient, size, chunk info, created time, downloaded flag |
| **push_subscriptions** | user, endpoint, keys, created time |

Indexes are needed on: code; friendship user pairs; queued messages by recipient; media by TTL.

---

## 10. Non-functional requirements

- **Performance:** text messages delivered under 300 ms on the LAN when both users are online. The UI stays responsive during media upload.
- **Mobile-first UI:** safe-area aware and dark-mode aware. Chat looks like a modern messenger; the decoy looks like a clean, ordinary to-do app.
- **Accessibility:** readable font sizes, sufficient contrast, and labeled controls.
- **Offline behavior:** the app shell loads from the service worker cache, and the decoy Tasks screen works offline.
- **Configuration:** all tunable values (file size limit, TTLs, rate limits, auto-lock default) are set via environment variables or a config file.

---

## 11. Deployment deliverables

- A Docker Compose setup for caddy (DuckDNS build), api, and mongo, with persistent volumes and restart policies.
- A `.env.example` covering:
  - DuckDNS subdomain and token
  - VAPID keys, plus a documented command to generate them
  - Mongo credentials
  - limits
- A **README** covering:
  - DHCP reservation and DuckDNS setup
  - first start
  - firewall rule for port 443 on the LAN
  - disabling sleep
  - the router DNS rebinding check
  - backup of Mongo and media volumes
  - the warning to never change the hostname
  - user onboarding steps for iOS and Android

---

## 12. Testing

- **Unit tests:** code derivation, vault wrap/unwrap (right and wrong password), message encrypt/decrypt round trips, and friendship enforcement on the server.
- **Integration tests:** two simulated clients covering register → request → accept → message → offline queue → reconnect → delivery.
- **Disguise test:** verify the wrong-password path renders the same decoy every time, with comparable timing to the correct path.
- **Manual device test matrix:** one real iPhone (installed PWA) and one real Android phone on the same Wi-Fi.
  - Test all features F1–F11, including push while the app is closed, notification tap → unlock → correct conversation, and cross-platform voice-note playback.

---

## 13. Milestones (build in this order)

1. **Infrastructure:** Docker Compose, Caddy with DuckDNS TLS, FastAPI health endpoint, PWA shell installable on both phones.
2. **Identity and vault:** key generation, code, password-wrapped vault, Tasks decoy screen, password gate with decoy behavior, auto-lock.
3. **Directory and friendships:** registration, challenge-response auth, presence list, search by code, friend requests with server enforcement.
4. **Messaging:** WebSocket relay, E2E text messages, offline queue, acks, receipts, typing, reconnection, encrypted local history.
5. **Media:** encrypted chunked upload/download, photos, video, voice notes, GIFs, thumbnails, TTL cleanup.
6. **Push:** subscriptions, disguised notifications, notification-tap → unlock → open conversation.
7. **Polish:** settings, change password, wipe, encrypted backup (should have), README, tests.

Each milestone should end in a working, demoable state on two real phones.

---

## 14. Known limitations (to be documented, not solved)

- Works only on the host's network. Push requires internet on both ends.
- iOS: notifications and reliable storage require the Home Screen install. Delivery may lag in Low Power or Focus modes.
- A forgotten password means unrecoverable history (unless F12 backup exists).
- The disguise protects against casual inspection only. Forensic examination of browser storage would reveal encrypted data.
- The server sees metadata (who, when, sizes).
- No forward secrecy in v1. A leaked device key exposes past messages that are still on the device.

---

## 15. Future work

- Group chats.
- Reactions, edits, and disappearing messages.
- Double Ratchet (Signal-style) for forward secrecy.
- Safety-number verification UI with QR scan.
- Multi-device support.
- A native wrapper if store-free PWA limits become a problem.
