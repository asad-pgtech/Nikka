"""End-to-end: register → request → accept → message → offline queue → reconnect → delivery."""

from __future__ import annotations

import json
from collections.abc import Callable

from fastapi.testclient import TestClient

from tests.simclient import SimClient, close, open_, recv_until, seal


def _text(body: str) -> bytes:
    return json.dumps({"t": "text", "body": body, "ts": 1}).encode()


def test_full_messaging_flow(client: TestClient, pushes: list[tuple[str, str]]) -> None:
    a, b = SimClient(client, "Alice"), SimClient(client, "Bob")
    for sim in (a, b):
        sim.register()
        sim.login()
    assert a.get(f"/api/users/{b.code}").json()["agreement_key"] == b.ak
    a.befriend(b)

    wa, wb = a.connect(), b.connect()

    # --- online delivery -------------------------------------------------------
    wa.send_json({"type": "send", "id": "m1", "to": b.code, "payload": seal(a, b, "m1", _text("hello"))})
    assert recv_until(wa, "sent")["id"] == "m1"
    item = recv_until(wb, "item")["item"]
    assert item["kind"] == "msg" and item["from"] == a.code and item["msg_id"] == "m1" and item["ref"]
    assert json.loads(open_(b, a, "m1", item["payload"]))["body"] == "hello"
    assert pushes == []  # recipient online: no push

    # Typing is relayed live.
    wa.send_json({"type": "typing", "to": b.code, "active": True})
    assert recv_until(wb, "typing") == {"type": "typing", "from": a.code, "active": True}

    # Ack → sender receives `delivered`.
    wb.send_json({"type": "ack", "qids": [item["qid"]]})
    delivered = recv_until(wa, "item")["item"]
    assert delivered["kind"] == "delivered" and delivered["msg_id"] == "m1" and delivered["from"] == b.code
    wa.send_json({"type": "ack", "qids": [delivered["qid"]]})

    # Read receipt.
    wb.send_json({"type": "read", "to": a.code, "ids": ["m1"]})
    read = recv_until(wa, "item")["item"]
    assert read["kind"] == "read" and read["msg_ids"] == ["m1"]
    wa.send_json({"type": "ack", "qids": [read["qid"]]})

    # --- recipient goes offline ------------------------------------------------
    close(wb)
    for mid in ("m2", "m3"):
        wa.send_json({"type": "send", "id": mid, "to": b.code, "payload": seal(a, b, mid, _text(mid))})
        assert recv_until(wa, "sent")["id"] == mid
    # Retry of the same id is idempotent.
    wa.send_json({"type": "send", "id": "m3", "to": b.code, "payload": seal(a, b, "m3", _text("m3"))})
    assert recv_until(wa, "sent")["id"] == "m3"
    assert [code for code, _ in pushes] == [b.code, b.code, b.code]
    assert all(ref for _, ref in pushes)

    # --- reconnect + sync --------------------------------------------------------
    wb = b.connect()
    wb.send_json({"type": "sync"})
    synced = recv_until(wb, "sync")
    assert synced["more"] is False
    msgs = [i for i in synced["items"] if i["kind"] == "msg"]
    assert [i["msg_id"] for i in msgs] == ["m2", "m3"]
    assert {i["ref"] for i in msgs} <= {ref for _, ref in pushes}
    assert json.loads(open_(b, a, "m2", msgs[0]["payload"]))["body"] == "m2"

    # A second sync on the same connection continues after the cursor.
    wb.send_json({"type": "sync"})
    assert recv_until(wb, "sync")["items"] == []

    wb.send_json({"type": "ack", "qids": [i["qid"] for i in msgs]})
    got = {recv_until(wa, "item")["item"]["msg_id"] for _ in range(2)}
    assert got == {"m2", "m3"}

    # Queue is empty after ack.
    close(wb)
    wb = b.connect()
    wb.send_json({"type": "sync"})
    assert recv_until(wb, "sync")["items"] == []
    close(wa)
    close(wb)


def test_ws_validation(users: Callable[[str], SimClient]) -> None:
    a, b = users("A"), users("B")
    a.befriend(b)
    ws = a.connect()
    try:
        ws.send_text("not json")
        assert recv_until(ws, "error")["code"] == "invalid"
        ws.send_json({"type": "bogus"})
        assert recv_until(ws, "error")["code"] == "unknown_type"
        ws.send_json({"type": "send", "id": "bad id!", "to": b.code, "payload": "AAAA"})
        assert recv_until(ws, "error")["code"] == "invalid"
        ws.send_json({"type": "send", "id": "m1", "to": b.code, "payload": "AAAA"})
        assert recv_until(ws, "error")["code"] == "invalid"  # too short to be an envelope
        big = seal(a, b, "m2", b"x" * (64 * 1024 + 1))
        ws.send_json({"type": "send", "id": "m2", "to": b.code, "payload": big})
        err = recv_until(ws, "error")
        assert err["code"] == "payload_too_large" and err["id"] == "m2"
        ws.send_json({"type": "ping"})
        assert recv_until(ws, "pong") == {"type": "pong"}
    finally:
        close(ws)


def test_silent_send_is_queued_without_push(client: TestClient, pushes: list[tuple[str, str]]) -> None:
    a, b = SimClient(client, "Alice"), SimClient(client, "Bob")
    for sim in (a, b):
        sim.register()
        sim.login()
    a.befriend(b)
    wa = a.connect()

    profile = json.dumps({"t": "profile", "ts": 1, "avatar": None}).encode()
    wa.send_json({"type": "send", "id": "p1", "to": b.code, "payload": seal(a, b, "p1", profile), "silent": True})
    assert recv_until(wa, "sent")["id"] == "p1"
    assert pushes == []  # recipient offline, but silent: no push

    wa.send_json({"type": "send", "id": "p2", "to": b.code, "payload": seal(a, b, "p2", profile), "silent": "yes"})
    err = recv_until(wa, "error")
    assert err["code"] == "invalid" and err["id"] == "p2"
    close(wa)

    wb = b.connect()
    wb.send_json({"type": "sync"})
    items = recv_until(wb, "sync")["items"]
    assert [i["msg_id"] for i in items] == ["p1"]
    close(wb)
