from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.security import akey_message, b64e
from tests.simclient import SimClient


def test_health_and_config(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}
    cfg = client.get("/api/config").json()
    assert cfg["max_file_bytes"] == 100 * 1024 * 1024
    assert cfg["chunk_bytes"] == 512 * 1024
    assert cfg["vapid_public_key"] is None


def test_register_idempotent_and_rejects_bad_input(client: TestClient) -> None:
    a = SimClient(client, "Alice")
    assert a.register().status_code == 201
    assert a.register().status_code == 200

    b = SimClient(client, "Bob")
    body = {
        "code": a.code,  # wrong code for b's key
        "display_name": "Bob",
        "identity_key": b.ik,
        "agreement_key": b.ak,
        "agreement_key_sig": b.sign(akey_message(b.agreement_pub)),
    }
    resp = client.post("/api/register", json=body)
    assert resp.status_code == 400 and resp.json()["detail"]["code"] == "code_mismatch"

    body["code"] = b.code
    body["agreement_key_sig"] = b64e(bytes(64))
    assert client.post("/api/register", json=body).json()["detail"]["code"] == "invalid_signature"

    body["agreement_key_sig"] = b.sign(akey_message(b.agreement_pub))
    body["display_name"] = "   "
    assert client.post("/api/register", json=body).status_code == 422
    body["display_name"] = "x" * 41
    assert client.post("/api/register", json=body).status_code == 422


def test_session_requires_valid_signature_and_single_use_nonce(client: TestClient) -> None:
    a = SimClient(client, "Alice")
    a.register()
    nonce = client.post("/api/auth/challenge", json={"code": a.code}).json()["nonce"]
    bad = client.post("/api/auth/session", json={"code": a.code, "nonce": nonce, "signature": b64e(bytes(64))})
    assert bad.status_code == 401
    # Nonce was consumed by the failed attempt.
    from app.core.security import auth_message

    again = client.post(
        "/api/auth/session", json={"code": a.code, "nonce": nonce, "signature": a.sign(auth_message(nonce))}
    )
    assert again.status_code == 401
    a.login()
    assert a.get("/api/me").json() == {
        "code": a.code,
        "display_name": "Alice",
        "username": None,
        "discoverable": True,
        "show_last_seen": True,
    }
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/me", headers={"Authorization": "Bearer v1.x.1.y"}).status_code == 401


def test_ws_rejects_bad_auth(client: TestClient) -> None:
    a = SimClient(client, "Alice")
    a.register()
    with client.websocket_connect("/api/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "auth", "code": a.code, "signature": b64e(bytes(64))})
        assert ws.receive_json()["code"] == "auth_failed"


def test_lookup_exact_only_and_rate_limited(make_client) -> None:  # type: ignore[no-untyped-def]
    client = make_client(lookup_per_minute=3)
    a, b = SimClient(client, "A"), SimClient(client, "B")
    for s in (a, b):
        s.register()
        s.login()
    dashed = f"{b.code[:4]}-{b.code[4:8]}-{b.code[8:]}".lower()
    assert a.get(f"/api/users/{dashed}").json()["code"] == b.code
    assert a.get(f"/api/users/{b.code[:2]}").status_code == 404  # neither a code nor a username: not rate-limited
    assert a.get(f"/api/users/{b.code}").status_code == 200
    assert a.get(f"/api/users/{b.code}").status_code == 200
    assert a.get(f"/api/users/{b.code}").status_code == 429


def test_body_size_limit(client: TestClient) -> None:
    resp = client.post("/api/register", content=b"x" * (70 * 1024), headers={"content-type": "application/json"})
    assert resp.status_code == 413


def test_usernames_unique_editable_and_findable(client: TestClient) -> None:
    a, b, c = SimClient(client, "A"), SimClient(client, "B"), SimClient(client, "C")
    a.register(username="Alice_1")
    assert b.register_raw(username="alice_1").json()["detail"]["code"] == "username_taken"
    assert b.register_raw(username="no").status_code == 422
    assert b.register_raw(username="bad-name").status_code == 422
    b.register()
    c.register()
    for s in (a, b, c):
        s.login()

    assert a.get("/api/me").json()["username"] == "alice_1"
    assert c.get("/api/users/alice_1").json()["code"] == a.code
    assert c.get("/api/users/@ALICE_1").json()["code"] == a.code
    assert c.get("/api/users/alice").status_code == 404

    assert b.patch("/api/me", json={"username": "alice_1"}).json()["detail"]["code"] == "username_taken"
    assert b.patch("/api/me", json={"username": "bob"}).json()["username"] == "bob"
    assert c.get("/api/users/bob").json()["username"] == "bob"

    # Renaming frees the old name.
    assert a.patch("/api/me", json={"username": "alice_2"}).json()["username"] == "alice_2"
    assert c.get("/api/users/alice_1").status_code == 404
    assert b.patch("/api/me", json={"username": "alice_1"}).status_code == 200
    # Keeping your own name is not a conflict.
    assert b.patch("/api/me", json={"username": "alice_1"}).status_code == 200


def test_username_that_looks_like_a_code(client: TestClient) -> None:
    a, b = SimClient(client, "A"), SimClient(client, "B")
    a.register(username="abcdefghjkmn")  # 12 chars from the code alphabet
    b.register()
    a.login()
    b.login()
    assert b.get("/api/users/abcdefghjkmn").json()["code"] == a.code
    assert b.get(f"/api/users/{a.code}").json()["code"] == a.code
