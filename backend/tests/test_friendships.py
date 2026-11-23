from __future__ import annotations

from collections.abc import Callable

from fastapi.testclient import TestClient

from tests.simclient import SimClient, close, recv_until, seal


def test_request_accept_and_listing(users: Callable[[str], SimClient]) -> None:
    a, b = users("A"), users("B")
    assert a.request_friend(b).status_code == 201
    assert a.request_friend(b).json()["detail"]["code"] == "already_pending"
    assert b.request_friend(a).json()["detail"]["code"] == "incoming_pending"

    incoming = b.get("/api/friends").json()["friends"]
    assert len(incoming) == 1
    entry = incoming[0]
    assert entry["code"] == a.code and entry["direction"] == "incoming" and entry["status"] == "pending"
    assert entry["identity_key"] == a.ik and entry["request_sig"]

    # Requester cannot accept their own request.
    assert a.accept_friend(b).status_code == 404
    assert b.accept_friend(a).status_code == 200
    assert a.get("/api/friends").json()["friends"][0]["status"] == "accepted"
    assert a.get("/api/friends").json()["friends"][0]["accept_sig"]
    assert a.request_friend(b).json()["detail"]["code"] == "already_friends"


def test_request_signature_and_self_checks(users: Callable[[str], SimClient]) -> None:
    a, b = users("A"), users("B")
    import time

    resp = a.post("/api/friends/request", json={"to": b.code, "ts": int(time.time() * 1000), "signature": "A" * 86})
    assert resp.json()["detail"]["code"] == "invalid_signature"
    assert a.request_friend(a).json()["detail"]["code"] == "self"


def test_cancel(users: Callable[[str], SimClient]) -> None:
    a, b = users("A"), users("B")
    a.request_friend(b)
    assert a.post(f"/api/friends/{b.code}/cancel").json() == {"status": "cancelled"}
    assert b.get("/api/friends").json()["friends"] == []


def test_decline_cooldown(users: Callable[[str], SimClient]) -> None:
    a, b = users("A"), users("B")
    a.request_friend(b)
    assert b.post(f"/api/friends/{a.code}/decline").status_code == 200
    assert a.get("/api/friends").json()["friends"][0]["status"] == "declined"
    assert b.get("/api/friends").json()["friends"] == []  # declined hidden from decliner
    resp = a.request_friend(b)
    assert resp.status_code == 429 and resp.json()["detail"]["code"] == "cooldown"
    # The decliner may still change their mind.
    assert b.request_friend(a).status_code == 201


def test_daily_cap(make_client) -> None:  # type: ignore[no-untyped-def]
    client: TestClient = make_client(request_daily_cap=2)
    sims = [SimClient(client, f"U{i}") for i in range(4)]
    for s in sims:
        s.register()
        s.login()
    me, *others = sims
    assert me.request_friend(others[0]).status_code == 201
    assert me.request_friend(others[1]).status_code == 201
    resp = me.request_friend(others[2])
    assert resp.status_code == 429 and resp.json()["detail"]["code"] == "daily_cap"


def test_relay_requires_friendship(users: Callable[[str], SimClient]) -> None:
    a, b = users("A"), users("B")
    ws = a.connect()
    try:
        ws.send_json({"type": "send", "id": "m1", "to": b.code, "payload": seal(a, b, "m1", b"hi")})
        err = recv_until(ws, "error")
        assert err["code"] == "not_friends" and err["id"] == "m1"
        ws.send_json({"type": "read", "to": b.code, "ids": ["m1"]})
        assert recv_until(ws, "error")["code"] == "not_friends"
    finally:
        close(ws)
    assert a.post("/api/media", json={"to": b.code, "size": 10, "chunk_count": 1}).status_code == 403


def test_block_stops_relay_and_hides_user(users: Callable[[str], SimClient]) -> None:
    a, b = users("A"), users("B")
    a.befriend(b)
    assert b.post(f"/api/friends/{a.code}/block").json() == {"status": "blocked"}

    ws = a.connect()
    try:
        ws.send_json({"type": "send", "id": "m1", "to": b.code, "payload": seal(a, b, "m1", b"hi")})
        assert recv_until(ws, "error")["code"] == "not_friends"
    finally:
        close(ws)
    assert a.get(f"/api/users/{b.code}").status_code == 404
    assert a.request_friend(b).status_code == 404
    assert a.get("/api/friends").json()["friends"] == []  # blocked by peer: invisible
    blocked = b.get("/api/friends").json()["friends"]
    assert blocked[0]["status"] == "blocked" and blocked[0]["blocked_by_me"] is True

    assert b.post(f"/api/friends/{a.code}/unblock").json() == {"status": "none"}
    assert b.get("/api/friends").json()["friends"] == []
    assert a.request_friend(b).status_code == 201


def test_presence_respects_discoverable_and_blocks(users: Callable[[str], SimClient]) -> None:
    a, b = users("A"), users("B")
    wa = a.connect()
    wb = b.connect()
    try:
        presence = recv_until(wa, "presence")
        while not any(u["code"] == b.code for u in presence["users"]):
            presence = recv_until(wa, "presence")
        assert presence["users"] == [{"code": b.code, "display_name": "B", "friend": False}]

        assert b.http.patch("/api/me", headers=b.headers, json={"discoverable": False}).status_code == 200
        presence = recv_until(wa, "presence")
        assert presence["users"] == []
    finally:
        close(wa)
        close(wb)


def test_last_seen_shared_between_friends(users: Callable[[str], SimClient]) -> None:
    a, b, c = users("A"), users("B"), users("C")
    a.befriend(b)
    assert a.get("/api/friends").json()["friends"][0]["last_seen"] is None  # B never connected

    sb = b.connect()
    sa = a.connect()
    sb.close(1000)  # graceful close so the server runs its disconnect path
    frame = recv_until(sa, "last_seen")
    close(sb)
    assert frame["code"] == b.code and isinstance(frame["ts"], int)
    assert a.get("/api/friends").json()["friends"][0]["last_seen"] == frame["ts"]

    # Strangers never get it, even via a pending request.
    c.request_friend(b)
    assert c.get("/api/friends").json()["friends"][0]["last_seen"] is None

    # Hiding is reciprocal: A hides theirs, so A no longer sees B's either.
    me = a.http.patch("/api/me", json={"show_last_seen": False}, headers=a.headers)
    assert me.status_code == 200 and me.json()["show_last_seen"] is False
    assert a.get("/api/friends").json()["friends"][0]["last_seen"] is None
    assert b.get("/api/friends").json()["friends"][0]["last_seen"] is None
    close(sa)
