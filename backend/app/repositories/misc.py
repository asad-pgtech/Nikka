"""Small collections: one-time auth nonces and the friend-request log."""

from __future__ import annotations

from datetime import datetime, timedelta

from app.core.clock import utcnow
from app.db.mongo import Collections
from app.repositories.base import Repository


class NonceRepository(Repository):
    collection_name = Collections.NONCES

    async def create(self, nonce: str, code: str, ttl_seconds: int) -> datetime:
        expires = utcnow() + timedelta(seconds=ttl_seconds)
        await self.col.insert_one({"nonce": nonce, "code": code, "expires_at": expires})
        return expires

    async def consume(self, nonce: str, code: str) -> bool:
        doc = await self.col.find_one_and_delete(
            {"nonce": nonce, "code": code, "expires_at": {"$gt": utcnow()}}
        )
        return doc is not None


class RequestLogRepository(Repository):
    collection_name = Collections.REQUEST_LOG

    async def count_since(self, code: str, since: datetime) -> int:
        return await self.col.count_documents({"code": code, "created_at": {"$gte": since}})

    async def record(self, code: str, to: str) -> None:
        await self.col.insert_one({"code": code, "to": to, "created_at": utcnow()})

    async def count_last_day(self, code: str) -> int:
        return await self.count_since(code, utcnow() - timedelta(days=1))
