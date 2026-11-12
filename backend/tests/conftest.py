from __future__ import annotations

import os
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pymongo import MongoClient
from pymongo.errors import PyMongoError

from app.core.config import Settings
from app.main import create_app
from tests.simclient import SimClient

MONGO_URL = os.environ.get("TEST_MONGO_URL", "mongodb://localhost:27017")


@pytest.fixture(scope="session")
def mongo_available() -> str:
    try:
        MongoClient(MONGO_URL, serverSelectionTimeoutMS=1500).admin.command("ping")
    except PyMongoError:
        pytest.skip(
            f"MongoDB not reachable at {MONGO_URL}. Start one with "
            "`docker run -d --rm --name lanchat-test-mongo -p 27017:27017 mongo:7` or set TEST_MONGO_URL."
        )
    return MONGO_URL


@pytest.fixture
def make_client(mongo_available: str, tmp_path_factory: pytest.TempPathFactory) -> Iterator[Callable[..., TestClient]]:
    """Factory: build an app with settings overrides and return an entered TestClient."""
    opened: list[tuple[TestClient, str]] = []

    def factory(**overrides: Any) -> TestClient:
        db_name = f"lanchat_test_{uuid.uuid4().hex[:12]}"
        params: dict[str, Any] = {
            "mongo_url": mongo_available,
            "mongo_db": db_name,
            "media_dir": tmp_path_factory.mktemp("media"),
            "vapid_public_key": None,
            "vapid_private_key": None,
            **overrides,
        }
        settings = Settings(**params)
        client = TestClient(create_app(settings))
        client.__enter__()
        opened.append((client, db_name))
        return client

    yield factory

    sync = MongoClient(mongo_available)
    for client, db_name in opened:
        client.__exit__(None, None, None)
        sync.drop_database(db_name)
    sync.close()


@pytest.fixture
def client(make_client: Callable[..., TestClient]) -> TestClient:
    return make_client()


@pytest.fixture
def pushes(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    calls: list[tuple[str, str]] = []
    push = client.app.state.container.push
    monkeypatch.setattr(push, "notify", lambda code, ref: calls.append((code, ref)))
    return calls


@pytest.fixture
def users(client: TestClient) -> Callable[[str], SimClient]:
    def factory(name: str) -> SimClient:
        sim = SimClient(client, name)
        sim.register()
        sim.login()
        return sim

    return factory
