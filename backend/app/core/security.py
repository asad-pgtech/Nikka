"""Crypto helpers: encoding, code derivation, Ed25519 verification, session tokens."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
CODE_LENGTH = 12
_CODE_RE = re.compile(rf"^[{CODE_ALPHABET}]{{{CODE_LENGTH}}}$")
_B64_RE = re.compile(r"^[A-Za-z0-9_-]*$")

AKEY_PREFIX = b"lanchat-akey-v1:"
AUTH_PREFIX = "lanchat-auth-v1:"
SIGNED_TS_SKEW_MS = 10 * 60 * 1000


# --- base64url ---------------------------------------------------------------
def b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64d(value: str) -> bytes:
    """Decode base64url without padding. Raises ValueError on malformed input."""
    if not isinstance(value, str) or not _B64_RE.match(value) or len(value) % 4 == 1:
        raise ValueError("invalid base64url")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def is_b64(value: str) -> bool:
    try:
        b64d(value)
        return True
    except ValueError:
        return False


# --- codes -------------------------------------------------------------------
def normalize_code(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", raw.upper())


def is_valid_code(code: str) -> bool:
    return bool(_CODE_RE.match(code))


def derive_code(identity_key: bytes) -> str:
    """First 60 bits of SHA-256(identity key), big-endian, 5 bits per char."""
    digest = hashlib.sha256(identity_key).digest()
    n = int.from_bytes(digest[:8], "big") >> 4
    return "".join(CODE_ALPHABET[(n >> (5 * (CODE_LENGTH - 1 - i))) & 31] for i in range(CODE_LENGTH))


# --- signatures --------------------------------------------------------------
def verify_ed25519(public_key: bytes, message: bytes, signature: bytes) -> bool:
    if len(public_key) != 32 or len(signature) != 64:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        return True
    except (InvalidSignature, ValueError):
        return False


def verify_ed25519_b64(public_key_b64: str, message: bytes, signature_b64: str) -> bool:
    try:
        return verify_ed25519(b64d(public_key_b64), message, b64d(signature_b64))
    except ValueError:
        return False


def akey_message(agreement_key: bytes) -> bytes:
    return AKEY_PREFIX + agreement_key


def auth_message(nonce: str) -> bytes:
    return f"{AUTH_PREFIX}{nonce}".encode()


def friend_statement(kind: str, sender: str, recipient: str, identity_key: str, agreement_key: str, ts: int) -> bytes:
    """kind is 'freq' (request) or 'facc' (accept)."""
    return f"lanchat-{kind}-v1|{sender}|{recipient}|{identity_key}|{agreement_key}|{ts}".encode()


def ts_fresh(ts: int, now_ms: int | None = None) -> bool:
    now = now_ms if now_ms is not None else now_ms_()
    return abs(now - ts) <= SIGNED_TS_SKEW_MS


def now_ms_() -> int:
    return int(time.time() * 1000)


def random_token(nbytes: int = 16) -> str:
    return b64e(secrets.token_bytes(nbytes))


# --- session tokens ------------------------------------------------------------
class TokenSigner:
    """Stateless HMAC tokens: `v1.<code>.<exp_ms>.<mac>`."""

    def __init__(self, secret: str, ttl_seconds: int) -> None:
        self._key = hashlib.sha256(secret.encode()).digest()
        self._ttl_ms = ttl_seconds * 1000

    def _mac(self, body: str) -> str:
        return b64e(hmac.new(self._key, body.encode(), hashlib.sha256).digest())

    def issue(self, code: str, now_ms: int | None = None) -> tuple[str, int]:
        exp = (now_ms if now_ms is not None else now_ms_()) + self._ttl_ms
        body = f"v1.{code}.{exp}"
        return f"{body}.{self._mac(body)}", exp

    def verify(self, token: str, now_ms: int | None = None) -> str | None:
        parts = token.split(".")
        if len(parts) != 4 or parts[0] != "v1":
            return None
        _, code, exp_raw, mac = parts
        body = f"v1.{code}.{exp_raw}"
        if not hmac.compare_digest(mac, self._mac(body)):
            return None
        try:
            exp = int(exp_raw)
        except ValueError:
            return None
        if exp <= (now_ms if now_ms is not None else now_ms_()):
            return None
        return code if is_valid_code(code) else None
