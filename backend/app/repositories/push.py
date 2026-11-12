from __future__ import annotations

from typing import Any

from app.core.clock import utcnow
from app.db.mongo import Collections
from app.repositories.base import Repository


class PushRepository(Repository):
    collection_name = Collections.PUSH

    async def upsert(self, code: str, endpoint: str, p256dh: str, auth: str) -> None:
        await self.col.update_one(
            {"endpoint": endpoint},
            {
                "$set": {"code": code, "p256dh": p256dh, "auth": auth},
                "$setOnInsert": {"created_at": utcnow()},
            },
            upsert=True,
        )

    async def for_user(self, code: str) -> list[dict[str, Any]]:
        return [d async for d in self.col.find({"code": code})]

    async def delete(self, endpoint: str, code: str | None = None) -> None:
        query: dict[str, Any] = {"endpoint": endpoint}
        if code is not None:
            query["code"] = code
        await self.col.delete_one(query)

    async def delete_for_user(self, code: str) -> None:
        await self.col.delete_many({"code": code})

    async def owner_codes(self) -> set[str]:
        return set(await self.col.distinct("code"))

    async def delete_for_codes(self, codes: set[str]) -> int:
        if not codes:
            return 0
        result = await self.col.delete_many({"code": {"$in": list(codes)}})
        return result.deleted_count
