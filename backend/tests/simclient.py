"""A minimal protocol client used by the tests (mirrors what the PWA does)."""

from __future__ import annotations

import time
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi.testclient import TestClient

from app.core.security import akey_message, auth_message, b64e, derive_code, friend_statement

RAW = serialization.Encoding.Raw, serialization.PublicFormat.Raw


class SimClient:
    def __init__(self, http: TestClient, name: str) -> None:
        self.http = http
        self.name = name
        self.sign_key = Ed25519PrivateKey.generate()
        self.agree_key = X25519PrivateKey.generate()
        self.identity_pub = self.sign_key.public_key().public_bytes(*RAW)
        self.agreement_pub = self.agree_key.public_key().public_bytes(*RAW)
        self.code = derive_code(self.identity_pub)
        self.ik = b64e(self.identity_pub)
        self.ak = b64e(self.agreement_pub)
        self.token: str | None = None

    def sign(self, message: bytes) -> str:
        return b64e(self.sign_key.sign(message))

    def register(self, discoverable: bool = True) -> Any:
        resp = self.http.post(
            "/api/register",
            json={
                "code": self.code,
                "display_name": self.name,
                "identity_key": self.ik,
                "agreement_key": self.ak,
                "agreement_key_sig": self.sign(akey_message(self.agreement_pub)),
                "discoverable": discoverable,
            },
        )
        assert resp.status_code in (200, 201), resp.text
        return resp

    def login(self) -> None:
        nonce = self.http.post("/api/auth/challenge", json={"code": self.code}).json()["nonce"]
        resp = self.http.post(
            "/api/auth/session", json={"code": self.code, "nonce": nonce, "signature": self.sign(auth_message(nonce))}
        )
        assert resp.status_code == 200, resp.text
        self.token = resp.json()["token"]

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def _kw(self, kw: dict[str, Any]) -> dict[str, Any]:
        return {**kw, "headers": {**self.headers, **kw.get("headers", {})}}

    def get(self, path: str, **kw: Any) -> Any:
        return self.http.get(path, **self._kw(kw))

    def post(self, path: str, **kw: Any) -> Any:
        return self.http.post(path, **self._kw(kw))

    def put(self, path: str, **kw: Any) -> Any:
        return self.http.put(path, **self._kw(kw))

    def request_friend(self, other: SimClient) -> Any:
        ts = int(time.time() * 1000)
        sig = self.sign(friend_statement("freq", self.code, other.code, self.ik, self.ak, ts))
        return self.post("/api/friends/request", json={"to": other.code, "ts": ts, "signature": sig})

    def accept_friend(self, requester: SimClient) -> Any:
        ts = int(time.time() * 1000)
        sig = self.sign(friend_statement("facc", self.code, requester.code, self.ik, self.ak, ts))
        return self.post(f"/api/friends/{requester.code}/accept", json={"ts": ts, "signature": sig})

    def befriend(self, other: SimClient) -> None:
        assert self.request_friend(other).status_code == 201
        assert other.accept_friend(self).status_code == 200

    # --- websocket -----------------------------------------------------------------
    def connect(self) -> Any:
        ws = self.http.websocket_connect("/api/ws")
        sock = ws.__enter__()
        challenge = sock.receive_json()
        assert challenge["type"] == "challenge"
        sock.send_json({"type": "auth", "code": self.code, "signature": self.sign(auth_message(challenge["nonce"]))})
        ready = sock.receive_json()
        assert ready["type"] == "ready", ready
        sock._ctx = ws  # type: ignore[attr-defined]
        return sock


def recv_until(sock: Any, kind: str, limit: int = 30) -> dict[str, Any]:
    for _ in range(limit):
        frame = sock.receive_json()
        if frame["type"] == kind:
            return frame
    raise AssertionError(f"no {kind} frame received")


def close(sock: Any) -> None:
    sock._ctx.__exit__(None, None, None)


# --- E2E envelope helpers (same construction as the PWA, see PROTOCOL.md) ---------
def _friend_key(me: SimClient, peer: SimClient) -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    shared = me.agree_key.exchange(X25519PublicKey.from_public_bytes(peer.agreement_pub))
    salt = "|".join(sorted((me.code, peer.code))).encode()
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=b"lanchat-friend-v1").derive(shared)


def seal(me: SimClient, peer: SimClient, msg_id: str, plaintext: bytes) -> str:
    import os

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    iv = os.urandom(12)
    aad = f"lanchat-msg-v1|{msg_id}|{me.code}|{peer.code}".encode()
    return b64e(iv + AESGCM(_friend_key(me, peer)).encrypt(iv, plaintext, aad))


def open_(me: SimClient, peer: SimClient, msg_id: str, payload: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    from app.core.security import b64d

    raw = b64d(payload)
    aad = f"lanchat-msg-v1|{msg_id}|{peer.code}|{me.code}".encode()
    return AESGCM(_friend_key(me, peer)).decrypt(raw[:12], raw[12:], aad)
