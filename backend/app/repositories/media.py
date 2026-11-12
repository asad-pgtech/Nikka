from __future__ import annotations

from datetime import datetime
from typing import Any

from app.db.mongo import Collections
from app.repositories.base import Repository


class MediaRepository(Repository):
    collection_name = Collections.MEDIA

    async def create(self, doc: dict[str, Any]) -> None:
        await self.col.insert_one(doc)

    async def get(self, blob_id: str) -> dict[str, Any] | None:
        return await self.col.find_one({"blob_id": blob_id})

    async def mark_chunk(self, blob_id: str, index: int) -> None:
        await self.col.update_one({"blob_id": blob_id}, {"$addToSet": {"received": index}})

    async def set_fields(self, blob_id: str, fields: dict[str, Any]) -> None:
        await self.col.update_one({"blob_id": blob_id}, {"$set": fields})

    async def delete(self, blob_id: str) -> None:
        await self.col.delete_one({"blob_id": blob_id})

    async def expired(self, older_than: datetime) -> list[str]:
        cursor = self.col.find(
            {"$or": [{"created_at": {"$lt": older_than}}, {"downloaded": True}]}, {"blob_id": 1}
        )
        return [d["blob_id"] async for d in cursor]

    async def for_user(self, code: str) -> list[str]:
        cursor = self.col.find({"$or": [{"uploader": code}, {"recipient": code}]}, {"blob_id": 1})
        return [d["blob_id"] async for d in cursor]

    async def all_ids(self) -> set[str]:
        return {d["blob_id"] async for d in self.col.find({}, {"blob_id": 1})}
