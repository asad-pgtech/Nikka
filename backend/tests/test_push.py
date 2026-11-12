from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pywebpush import WebPushException

from app.scripts.gen_vapid import generate
from app.services import push as push_module
from tests.simclient import SimClient

SUB = {"endpoint": "https://push.example.com/abc", "keys": {"p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", "auth": "tBHItJI5svbpez7KI4CCXg"}}


def test_push_payload_is_opaque_and_gone_subscriptions_removed(make_client, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    public, private = generate()
    client: TestClient = make_client(vapid_public_key=public, vapid_private_key=private)
    assert client.get("/api/config").json()["vapid_public_key"] == public

    a = SimClient(client, "A")
    a.register()
    a.login()
    assert a.post("/api/push/subscribe", json=SUB).status_code == 204

    sent: list[dict[str, Any]] = []

    def fake_webpush(**kwargs: Any) -> Any:
        sent.append(kwargs)
        raise WebPushException("gone", response=SimpleNamespace(status_code=410))

    monkeypatch.setattr(push_module, "webpush", fake_webpush)
    container = client.app.state.container

    async def run() -> int:
        container.push.notify(a.code, "REF123")
        await container.push.drain()
        return len(await container.push_repo.for_user(a.code))

    assert client.portal.call(run) == 0  # type: ignore[union-attr]
    assert json.loads(sent[0]["data"]) == {"ref": "REF123"}
    assert sent[0]["headers"]["Urgency"] == "high"
    assert sent[0]["ttl"] == 86400


def test_push_test_endpoint_reports_status(make_client, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    public, private = generate()
    client: TestClient = make_client(vapid_public_key=public, vapid_private_key=private)
    a = SimClient(client, "A")
    a.register()
    a.login()

    empty = a.post("/api/push/test").json()
    assert empty == {"enabled": True, "subscriptions": 0, "statuses": []}

    assert a.post("/api/push/subscribe", json=SUB).status_code == 204
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(push_module, "webpush", lambda **kw: sent.append(kw) or SimpleNamespace(status_code=201))
    res = a.post("/api/push/test").json()
    assert res == {"enabled": True, "subscriptions": 1, "statuses": [201]}
    assert set(json.loads(sent[0]["data"])) == {"ref"}


def test_no_topic_header_apple_rejects_it(make_client, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    public, private = generate()
    client: TestClient = make_client(vapid_public_key=public, vapid_private_key=private)
    a = SimClient(client, "A")
    a.register()
    a.login()
    a.post("/api/push/subscribe", json=SUB)
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(push_module, "webpush", lambda **kw: sent.append(kw) or SimpleNamespace(status_code=201))
    a.post("/api/push/test")
    assert "Topic" not in sent[0]["headers"]
