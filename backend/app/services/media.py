"""Encrypted media blob storage on the host filesystem.

Layout: MEDIA_DIR/{blob_id}/{index}.bin — ciphertext only.
"""

from __future__ import annotations

import logging
import math
import os
import re
import shutil
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import anyio

from app.core.clock import utcnow
from app.core.config import Settings
from app.core.errors import AppError, bad_request, conflict, not_found
from app.core.security import random_token
from app.repositories.media import MediaRepository
from app.services.friends import FriendService

log = logging.getLogger(__name__)

BLOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
GCM_TAG = 16


class MediaService:
    def __init__(self, settings: Settings, repo: MediaRepository, friends: FriendService) -> None:
        self._settings = settings
        self._repo = repo
        self._friends = friends
        self._root = Path(settings.media_dir)

    def ensure_storage(self) -> None:
        self._root.mkdir(parents=True, exist_ok=True)

    # --- lifecycle ----------------------------------------------------------------
    async def create(self, uploader: str, to: str, size: int, chunk_count: int) -> str:
        s = self._settings
        if not await self._friends.are_friends(uploader, to):
            raise AppError(403, "not_friends", "Not friends")
        if size > s.max_file_bytes + GCM_TAG * chunk_count or chunk_count > s.max_chunks:
            raise AppError(413, "too_large", "File too large")
        # `size` may be plaintext or ciphertext length; either way the chunk count must fit.
        if not math.ceil(size / (s.chunk_bytes + GCM_TAG)) <= chunk_count <= max(1, math.ceil(size / s.chunk_bytes)):
            raise bad_request("invalid", "chunk_count does not match size")

        blob_id = random_token(16)
        await anyio.Path(self._dir(blob_id)).mkdir(parents=True, exist_ok=True)
        await self._repo.create(
            {
                "blob_id": blob_id,
                "uploader": uploader,
                "recipient": to,
                "size": size,
                "chunk_count": chunk_count,
                "received": [],
                "complete": False,
                "downloaded": False,
                "created_at": utcnow(),
            }
        )
        log.info("media created uploader=%s recipient=%s", uploader, to)
        return blob_id

    async def put_chunk(self, me: str, blob_id: str, index: int, body: AsyncIterator[bytes]) -> None:
        doc = await self._get_for(me, blob_id, uploader_only=True)
        if doc["complete"]:
            raise conflict("complete", "Blob already complete")
        self._check_index(doc, index)

        limit = self._settings.max_chunk_body_bytes
        final = self._chunk_path(blob_id, index)
        tmp = final.with_suffix(f".{random_token(6)}.part")
        total = 0
        try:
            async with await anyio.open_file(tmp, "wb") as fh:
                async for part in body:
                    total += len(part)
                    if total > limit:
                        raise AppError(413, "too_large", "Chunk too large")
                    await fh.write(part)
            if total == 0:
                raise bad_request("invalid", "Empty chunk")
            await anyio.to_thread.run_sync(os.replace, tmp, final)
        finally:
            if await anyio.Path(tmp).exists():
                await anyio.Path(tmp).unlink()
        await self._repo.mark_chunk(blob_id, index)

    async def status(self, me: str, blob_id: str) -> dict[str, Any]:
        doc = await self._get_for(me, blob_id)
        return {
            "blob_id": doc["blob_id"],
            "size": doc["size"],
            "chunk_count": doc["chunk_count"],
            "received": sorted(doc["received"]),
            "complete": doc["complete"],
        }

    async def complete(self, me: str, blob_id: str) -> None:
        doc = await self._get_for(me, blob_id, uploader_only=True)
        if len(set(doc["received"])) != doc["chunk_count"]:
            raise conflict("incomplete", "Missing chunks")
        await self._repo.set_fields(blob_id, {"complete": True})

    async def chunk_path(self, me: str, blob_id: str, index: int) -> Path:
        doc = await self._get_for(me, blob_id)
        if not doc["complete"]:
            raise conflict("incomplete", "Upload not complete")
        self._check_index(doc, index)
        path = self._chunk_path(blob_id, index)
        if not await anyio.Path(path).exists():
            raise not_found()
        return path

    async def downloaded(self, me: str, blob_id: str) -> None:
        doc = await self._get_for(me, blob_id)
        if doc["recipient"] != me:
            raise not_found()
        await self.delete(blob_id)
        log.info("media downloaded recipient=%s", me)

    async def delete(self, blob_id: str) -> None:
        await self._repo.delete(blob_id)
        await anyio.to_thread.run_sync(shutil.rmtree, self._dir(blob_id), True)

    async def expire(self) -> int:
        cutoff = utcnow() - timedelta(days=self._settings.media_ttl_days)
        ids = await self._repo.expired(cutoff)
        for blob_id in ids:
            await self.delete(blob_id)
        # Orphan directories (e.g. crash between file write and DB insert).
        known = await self._repo.all_ids()
        if self._root.exists():
            for entry in self._root.iterdir():
                if entry.is_dir() and entry.name not in known:
                    age = utcnow().timestamp() - entry.stat().st_mtime
                    if age > 3600:
                        await anyio.to_thread.run_sync(shutil.rmtree, entry, True)
        return len(ids)

    async def delete_for_user(self, code: str) -> None:
        for blob_id in await self._repo.for_user(code):
            await self.delete(blob_id)

    # --- helpers ------------------------------------------------------------------
    def _dir(self, blob_id: str) -> Path:
        if not BLOB_ID_RE.match(blob_id):
            raise not_found()
        return self._root / blob_id

    def _chunk_path(self, blob_id: str, index: int) -> Path:
        return self._dir(blob_id) / f"{index}.bin"

    @staticmethod
    def _check_index(doc: dict[str, Any], index: int) -> None:
        if not 0 <= index < doc["chunk_count"]:
            raise bad_request("invalid", "Chunk index out of range")

    async def _get_for(self, me: str, blob_id: str, uploader_only: bool = False) -> dict[str, Any]:
        if not BLOB_ID_RE.match(blob_id):
            raise not_found()
        doc = await self._repo.get(blob_id)
        if doc is None:
            raise not_found()
        allowed = {doc["uploader"]} if uploader_only else {doc["uploader"], doc["recipient"]}
        if me not in allowed:
            raise not_found()
        return doc
