from __future__ import annotations

import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.core.security import (
    TokenSigner,
    b64d,
    b64e,
    derive_code,
    friend_statement,
    is_valid_code,
    normalize_code,
    ts_fresh,
    verify_ed25519,
    verify_ed25519_b64,
)


def test_code_derivation_vectors() -> None:
    assert derive_code(bytes(range(32))) == "EE8WUCD8SJTQ"
    assert derive_code(bytes(32)) == "ETN9PDHSECYR"


def test_code_normalization() -> None:
    assert normalize_code("ee8w-ucd8-sjtq") == "EE8WUCD8SJTQ"
    assert normalize_code(" EE8W UCD8 SJTQ ") == "EE8WUCD8SJTQ"
    assert is_valid_code("EE8WUCD8SJTQ")
    assert not is_valid_code("EE8WUCD8SJT0")  # 0 not in alphabet
    assert not is_valid_code("EE8WUCD8SJT")


def test_b64_roundtrip_and_rejects_garbage() -> None:
    data = bytes(range(50))
    assert b64d(b64e(data)) == data
    assert "=" not in b64e(data)
    with pytest.raises(ValueError):
        b64d("ab+/")
    with pytest.raises(ValueError):
        b64d("a")


def test_token_sign_verify_and_expiry() -> None:
    signer = TokenSigner("secret", ttl_seconds=60)
    now = int(time.time() * 1000)
    token, exp = signer.issue("EE8WUCD8SJTQ", now_ms=now)
    assert exp == now + 60_000
    assert signer.verify(token, now_ms=now) == "EE8WUCD8SJTQ"
    assert signer.verify(token, now_ms=exp) is None  # expired
    assert TokenSigner("other", 60).verify(token, now_ms=now) is None  # wrong key
    tampered = token.replace("EE8WUCD8SJTQ", "ETN9PDHSECYR")
    assert signer.verify(tampered, now_ms=now) is None
    assert signer.verify("garbage", now_ms=now) is None


def test_ed25519_verification() -> None:
    key = Ed25519PrivateKey.generate()
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    msg = friend_statement("freq", "A" * 12, "B" * 12, "ik", "ak", 1)
    sig = key.sign(msg)
    assert verify_ed25519(pub, msg, sig)
    assert not verify_ed25519(pub, msg + b"x", sig)
    assert not verify_ed25519(pub, msg, sig[:-1])
    assert verify_ed25519_b64(b64e(pub), msg, b64e(sig))
    assert not verify_ed25519_b64("!!", msg, b64e(sig))


def test_ts_window() -> None:
    now = 1_000_000_000_000
    assert ts_fresh(now - 9 * 60_000, now)
    assert not ts_fresh(now - 11 * 60_000, now)
