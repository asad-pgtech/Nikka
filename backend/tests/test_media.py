from __future__ import annotations

import os

from fastapi.testclient import TestClient

from tests.simclient import SimClient

CHUNK = 16 * 1024


def _pair(client: TestClient) -> tuple[SimClient, SimClient, SimClient]:
    sims = [SimClient(client, n) for n in ("A", "B", "C")]
    for s in sims:
        s.register()
        s.login()
    sims[0].befriend(sims[1])
    return sims[0], sims[1], sims[2]


def test_chunked_upload_download_and_cleanup(make_client) -> None:  # type: ignore[no-untyped-def]
    client: TestClient = make_client(chunk_kb=16, max_file_mb=1)
    a, b, c = _pair(client)
    chunks = [os.urandom(CHUNK + 16), os.urandom(1000)]

    created = a.post("/api/media", json={"to": b.code, "size": sum(map(len, chunks)), "chunk_count": 2})
    assert created.status_code == 201, created.text
    blob = created.json()["blob_id"]
    assert created.json()["chunk_bytes"] == CHUNK

    octet = {"content-type": "application/octet-stream"}
    assert a.put(f"/api/media/{blob}/chunks/1", content=chunks[1], headers=octet).status_code == 204
    status = a.get(f"/api/media/{blob}").json()
    assert status["received"] == [1] and status["complete"] is False  # resumable: client sees what is missing
    assert a.post(f"/api/media/{blob}/complete").status_code == 409
    assert b.get(f"/api/media/{blob}/chunks/1").status_code == 409

    # Only the uploader may upload; outsiders see nothing.
    assert b.put(f"/api/media/{blob}/chunks/0", content=b"x", headers=octet).status_code == 404
    assert c.get(f"/api/media/{blob}").status_code == 404

    assert a.put(f"/api/media/{blob}/chunks/0", content=chunks[0], headers=octet).status_code == 204
    assert a.post(f"/api/media/{blob}/complete").status_code == 200

    for i, data in enumerate(chunks):
        got = b.get(f"/api/media/{blob}/chunks/{i}")
        assert got.status_code == 200 and got.content == data
    assert a.post(f"/api/media/{blob}/downloaded").status_code == 404  # recipient only
    assert b.post(f"/api/media/{blob}/downloaded").status_code == 204
    assert b.get(f"/api/media/{blob}").status_code == 404
    media_dir = client.app.state.container.settings.media_dir
    assert not (media_dir / blob).exists()


def test_media_limits(make_client) -> None:  # type: ignore[no-untyped-def]
    client: TestClient = make_client(chunk_kb=16, max_file_mb=1)
    a, b, c = _pair(client)
    too_big = a.post("/api/media", json={"to": b.code, "size": 2 * 1024 * 1024, "chunk_count": 128})
    assert too_big.status_code == 413
    mismatch = a.post("/api/media", json={"to": b.code, "size": 100_000, "chunk_count": 1})
    assert mismatch.status_code == 400
    assert a.post("/api/media", json={"to": c.code, "size": 10, "chunk_count": 1}).status_code == 403

    blob = a.post("/api/media", json={"to": b.code, "size": 10, "chunk_count": 1}).json()["blob_id"]
    octet = {"content-type": "application/octet-stream"}
    assert a.put(f"/api/media/{blob}/chunks/0", content=os.urandom(CHUNK + 17), headers=octet).status_code == 413
    assert a.put(f"/api/media/{blob}/chunks/5", content=b"abc", headers=octet).status_code == 400


def test_media_ttl_expiry(make_client) -> None:  # type: ignore[no-untyped-def]
    import anyio

    from app.core.clock import utcnow
    from app.jobs.scheduler import expire_media

    client: TestClient = make_client(chunk_kb=16)
    a, b, _ = _pair(client)
    blob = a.post("/api/media", json={"to": b.code, "size": 10, "chunk_count": 1}).json()["blob_id"]
    container = client.app.state.container

    async def age_and_expire() -> int:
        from datetime import timedelta

        await container.media_repo.set_fields(blob, {"created_at": utcnow() - timedelta(days=31)})
        return await expire_media(container)

    assert client.portal.call(age_and_expire) == 1  # type: ignore[union-attr]
    assert a.get(f"/api/media/{blob}").status_code == 404
    del anyio
