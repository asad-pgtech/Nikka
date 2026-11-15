# Tasks (LAN Chat)

A private, end-to-end encrypted 1:1 chat that runs on your own computer and is used over your
home/office Wi-Fi. It installs on iPhone and Android as a web app (PWA) with no app store, and it
looks like a to-do app called **Tasks**.

* Spec: [`lan-chat-spec.md`](lan-chat-spec.md)
* Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
* Wire protocol: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)

```
frontend/   React + TypeScript + Vite PWA
backend/    FastAPI (Python 3.12) relay/directory
infra/      Docker Compose (caddy, api, mongo), Caddy image, .env.example, scripts
```

> ## ⚠️ Never change the hostname
> Each phone stores its keys and its entire chat history in browser storage that belongs to
> `https://<your-subdomain>.duckdns.org`. If you change the subdomain, or move to another name,
> every installed app starts empty and **all history is lost**. Pick the name once.
>
> If you must rename: point the new name at the host (`make duckdns-ip` after editing
> `DUCKDNS_SUBDOMAIN`), set `EXTRA_HOSTNAMES=<old>.duckdns.org` so the old app keeps working, and
> `make build up`. Each person exports a backup in the old app, installs from the new address,
> chooses "Restore from a backup" (same code, friends and history), and re-enables notifications.
> Remove `EXTRA_HOSTNAMES` once everyone has moved.

---

## 1. Requirements

* A computer that stays on (Linux, macOS or Windows with Docker Desktop), Docker Engine 24+ with Compose v2.
* A router where you can set a **DHCP reservation**.
* A free [DuckDNS](https://www.duckdns.org) account.
* Phones: iPhone with **iOS 16.4+** (Safari), Android with current **Chrome**.
* Internet on the host (certificate renewal, sending pushes) and on phones (DNS lookup, receiving pushes).
  Chat traffic itself stays on your LAN.

## 2. One-time network setup

### 2.1 Fixed LAN IP (DHCP reservation)
In your router's admin page (often `192.168.0.1` or `192.168.1.1`) → *LAN / DHCP* → *Address reservation*,
reserve an IP for the host's MAC address, e.g. `192.168.1.50`. Reboot the host or renew its lease and check:
```bash
ip -4 addr        # Linux
ipconfig getifaddr en0   # macOS
```

### 2.2 DuckDNS name → private IP
1. Sign in at duckdns.org, create a subdomain (e.g. `mytasks`), copy your **token**.
2. `make env` and put `DUCKDNS_SUBDOMAIN` and `DUCKDNS_TOKEN` into `infra/.env`.
3. Point the name at the **private** LAN IP:
   ```bash
   make duckdns-ip              # auto-detects this host's LAN IP
   ./infra/scripts/duckdns-set-ip.sh 192.168.1.50   # or explicitly
   ```
   (You can also type the IP into the DuckDNS web page.) The host never needs to be reachable from
   the internet: certificates are issued with the DNS-01 challenge.

### 2.3 Router DNS rebinding check
Many routers (and Pi-hole, AdGuard, some ISPs) block public names that resolve to private IPs.
Symptom: phones can't open the site, or `nslookup` returns nothing for your name. Diagnose from a
computer on the same Wi-Fi:
```bash
make check-dns
```
If public DNS returns your LAN IP but your network doesn't, whitelist the name:

| Where | Setting |
|---|---|
| OpenWrt | *Network → DHCP and DNS → Rebind protection*: add `duckdns.org` to *Domain whitelist* (or `rebind_domain`) |
| FRITZ!Box | *Home Network → Network → Network Settings → DNS Rebind Protection*: add `<sub>.duckdns.org` |
| pfSense / OPNsense | *Services → DNS Resolver → Custom options*: `private-domain: "duckdns.org"` |
| Pi-hole / dnsmasq | `rebind-domain-ok=/duckdns.org/` |
| AdGuard Home | disable *Rebinding protection* for the domain, or add a DNS rewrite `<sub>.duckdns.org → 192.168.1.50` |
| ISP router without option | set phone Wi-Fi DNS to `1.1.1.1`, or add a local DNS override for the name |

### 2.4 Firewall: allow 443 (and 80) from the LAN
```bash
# Ubuntu / ufw
sudo ufw allow from 192.168.1.0/24 to any port 443 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 80 proto tcp
# firewalld
sudo firewall-cmd --permanent --add-service=https --add-service=http && sudo firewall-cmd --reload
```
Windows: *Windows Defender Firewall → Inbound rule → Port → TCP 443, 80 → Private profile*.
macOS: Docker Desktop prompts on first run; allow incoming connections.
Do **not** forward these ports on the router.

### 2.5 Disable sleep on the host
* Linux (systemd): `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`
* macOS: *System Settings → Energy*: prevent automatic sleeping; or `sudo pmset -a sleep 0 disksleep 0`
* Windows: *Settings → System → Power*: Sleep = **Never** (plugged in).

Also make Docker start on boot (`sudo systemctl enable docker`, or Docker Desktop → *Start on login*).
All containers use `restart: unless-stopped`.

## 3. First start

```bash
make env                       # creates infra/.env from infra/.env.example
# edit infra/.env:
#   DUCKDNS_SUBDOMAIN, DUCKDNS_TOKEN
#   MONGO_ROOT_PASSWORD   (letters/digits, long)
#   SESSION_SECRET        → openssl rand -hex 32
make vapid                     # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY → paste into infra/.env
make up                        # builds images (first build takes a few minutes) and starts the stack
make ps                        # all three services should be "healthy"/"running"
make logs                      # watch Caddy obtain the certificate (look for "certificate obtained")
```
Open `https://<sub>.duckdns.org` on a phone on the same Wi-Fi.

Generate VAPID keys **once**. Changing them breaks existing push subscriptions (users would need to
toggle notifications off and on).

Useful: `make down`, `make restart`, `make build`, `make help`.

### Configuration
Everything tunable lives in `infra/.env` (see comments in `.env.example`): max file size, chunk
size, message payload limit, media TTL (default 30 days), queue TTL, friend-request cooldown and
daily cap, lookup rate limit, default auto-lock (2 min), session TTL, job interval.
If you raise `CHUNK_KB` above ~4000, raise `request_body max_size` in `infra/caddy/Caddyfile` too.

## 4. Using it on phones

### iPhone (iOS 16.4+)
1. Open `https://<sub>.duckdns.org` in **Safari**.
2. Tap **Share → Add to Home Screen → Add**. Open **Tasks** from the Home Screen
   (notifications and reliable storage only work in the installed app).
3. Set a display name and password. Read the warnings: a forgotten password means the history is
   gone; a wrong password just shows the to-do list.
4. Share your code (`XXXX-XXXX-XXXX`) with friends.
5. To unlock later: **long-press the "Tasks" title**.
6. Settings → **Notifications** → allow.

### Android (Chrome)
1. Open the address in **Chrome** → tap **Install** (or menu → *Install app / Add to Home screen*).
2. Same steps 3–6 as above.

### Everyday use
* **People** tab: see who is online (if they are discoverable), or find someone by exact code → **Add**.
  They accept under **Requests**. Only then can you chat.
* Attach photos, videos, files, GIFs; tap the mic to record a voice note.
* Long-press a message: reply, copy, delete for me / for everyone.
* The app locks itself when you switch away or after the idle timeout.
* Notifications look like reminders: `"<a random to-do>" is due today.` Tapping one opens the task
  list (that task shows as due today); long-press
  the title and unlock to jump straight to the conversation that received the message.

## 5. Backups (server side)

The server only holds ciphertext in transit (messages are deleted on delivery, media after download
or TTL), so its backup mainly preserves accounts and friendships.
```bash
make backup                                    # → backups/mongo-*.archive.gz + backups/media-*.tar.gz
./infra/scripts/restore.sh backups/mongo-….archive.gz backups/media-….tar.gz
```
Volumes: `tasks_mongo-data`, `tasks_media-data`, `tasks_caddy-data` (certificates), `tasks_caddy-config`.

**Chat history lives only on phones.** Each user can export an encrypted backup file from
*Settings → Export encrypted backup* (separate passphrase) and restore it on a fresh install of the
**same address** ("Restore from a backup" during setup).

## 6. Development

```bash
make dev-db        # MongoDB on 127.0.0.1:27017
make dev-api       # FastAPI with reload on :8000   (cd backend && uv sync first)
make dev-web       # Vite on http://localhost:5173, proxies /api (incl. WebSocket) to :8000
```
`localhost` is a secure context, so WebCrypto works in a desktop browser. Use two origins
(`http://localhost:5173` and `http://127.0.0.1:5173`) to simulate two users with separate storage.
If port 8000 is busy, run the API elsewhere and start Vite with `VITE_API_PROXY=http://127.0.0.1:8100`.
Node 20+ is required for production builds (`.nvmrc`).

### Tests
```bash
make test-backend          # pytest: unit + two-client integration (needs make dev-db)
make test-frontend         # vitest: code derivation, vault right/wrong password, message/media
                           # round trips, encrypted storage, disguise timing
# cross-implementation: frontend crypto/protocol code against a running API
cd frontend && E2E_API_URL=http://127.0.0.1:8000 npx vitest run src/test/interop.e2e.test.ts
```

### Manual device test matrix (spec §12)
One installed iPhone + one Android on the same Wi-Fi: F1–F11, including push while the app is
closed, notification tap → unlock → correct conversation, and voice notes recorded on each platform
played on the other.

## 7. Known limitations
* Works only on the host's network. Push needs internet on both ends.
* iOS: notifications and reliable storage require the Home Screen install; delivery may lag in
  Low Power or Focus modes.
* Forgotten password = unrecoverable history (unless you exported a backup).
* The disguise protects against casual inspection, not forensic analysis of browser storage.
* The server sees metadata: who talks to whom, when, and media sizes.
* No forward secrecy in v1: a leaked device key exposes past messages still on that device.
* One API worker (in-memory presence); fine for a household/office.

## 8. Troubleshooting
| Symptom | Check |
|---|---|
| Phone: "server not found" | `make check-dns` → DNS rebinding (§2.3); DuckDNS IP still correct? |
| Certificate errors / Caddy log `DNS challenge` failures | `DUCKDNS_TOKEN`, subdomain spelling; host has internet |
| Page loads, but "Connecting…" forever | Firewall (§2.4); `make logs` for api errors |
| No notifications on iPhone | App must be opened from Home Screen; Settings → Notifications on; iOS ≥ 16.4; `VAPID_*` set |
| Voice note won't play | Update the phone browser; recordings are AAC/MP4, or WAV when the recorder only supports WebM |
