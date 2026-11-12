from __future__ import annotations

from typing import Any

from app.db.mongo import Collections
from app.repositories.base import Repository


def pair_key(a: str, b: str) -> str:
    lo, hi = sorted((a, b))
    return f"{lo}|{hi}"


class FriendshipRepository(Repository):
    collection_name = Collections.FRIENDSHIPS

    async def get(self, a: str, b: str) -> dict[str, Any] | None:
        return await self.col.find_one({"pair": pair_key(a, b)})

    async def replace(self, a: str, b: str, doc: dict[str, Any]) -> None:
        doc = {**doc, "pair": pair_key(a, b), "users": sorted((a, b))}
        await self.col.replace_one({"pair": doc["pair"]}, doc, upsert=True)

    async def update(self, a: str, b: str, update: dict[str, Any]) -> None:
        await self.col.update_one({"pair": pair_key(a, b)}, update)

    async def delete(self, a: str, b: str) -> None:
        await self.col.delete_one({"pair": pair_key(a, b)})

    async def for_user(self, code: str) -> list[dict[str, Any]]:
        return [doc async for doc in self.col.find({"users": code})]

    async def among(self, codes: list[str]) -> list[dict[str, Any]]:
        """Relationships where both members are in `codes`."""
        if len(codes) < 2:
            return []
        cursor = self.col.find({"users": {"$in": codes}, "status": {"$in": ["accepted", "blocked"]}})
        wanted = set(codes)
        return [doc async for doc in cursor if set(doc["users"]) <= wanted]

    async def are_friends(self, a: str, b: str) -> bool:
        doc = await self.col.find_one({"pair": pair_key(a, b), "status": "accepted"}, {"_id": 1})
        return doc is not None

    async def is_blocked(self, a: str, b: str) -> bool:
        doc = await self.col.find_one({"pair": pair_key(a, b), "status": "blocked"}, {"_id": 1})
        return doc is not None

    async def delete_for_user(self, code: str) -> list[str]:
        """Delete all relationships of `code`; return the peers affected."""
        docs = await self.for_user(code)
        await self.col.delete_many({"users": code})
        return [u for d in docs for u in d["users"] if u != code]
