from __future__ import annotations

from datetime import datetime
from typing import Any

from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from app.db.mongo import Collections
from app.repositories.base import Repository


class QueueRepository(Repository):
    collection_name = Collections.QUEUE

    async def insert(self, item: dict[str, Any]) -> dict[str, Any]:
        """Insert an item. For `msg` items a duplicate (to, from, msg_id) returns the existing one."""
        try:
            await self.col.insert_one(item)
            return item
        except DuplicateKeyError:
            if item.get("kind") != "msg":
                raise
            existing = await self.col.find_one(
                {"kind": "msg", "to": item["to"], "from": item["from"], "msg_id": item["msg_id"]}
            )
            return existing or item

    async def page(self, to: str, after: ObjectId | None, limit: int) -> tuple[list[dict[str, Any]], bool]:
        query: dict[str, Any] = {"to": to, "delivered": {"$ne": True}}
        if after is not None:
            query["_id"] = {"$gt": after}
        docs = [d async for d in self.col.find(query).sort("_id", 1).limit(limit + 1)]
        return docs[:limit], len(docs) > limit

    async def take(self, to: str, qids: list[str]) -> list[dict[str, Any]]:
        """Remove the given items addressed to `to` and return them."""
        query = {"to": to, "qid": {"$in": qids}}
        docs = [d async for d in self.col.find(query)]
        if docs:
            await self.col.delete_many({"_id": {"$in": [d["_id"] for d in docs]}})
        return docs

    async def purge(self, older_than: datetime) -> int:
        result = await self.col.delete_many({"$or": [{"delivered": True}, {"created_at": {"$lt": older_than}}]})
        return result.deleted_count

    async def delete_for_user(self, code: str) -> None:
        await self.col.delete_many({"$or": [{"to": code}, {"from": code}]})
