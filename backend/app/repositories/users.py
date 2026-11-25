from __future__ import annotations

from typing import Any

from app.core.clock import utcnow
from app.db.mongo import Collections
from app.repositories.base import Repository


class UserRepository(Repository):
    collection_name = Collections.USERS

    async def get(self, code: str) -> dict[str, Any] | None:
        return await self.col.find_one({"code": code})

    async def get_by_username(self, username: str) -> dict[str, Any] | None:
        return await self.col.find_one({"username": username})

    async def get_many(self, codes: list[str]) -> dict[str, dict[str, Any]]:
        if not codes:
            return {}
        cursor = self.col.find({"code": {"$in": codes}})
        return {doc["code"]: doc async for doc in cursor}

    async def create(
        self,
        *,
        code: str,
        display_name: str,
        username: str | None,
        identity_key: str,
        agreement_key: str,
        agreement_key_sig: str,
        discoverable: bool,
    ) -> None:
        doc: dict[str, Any] = {
            "code": code,
            "display_name": display_name,
            "identity_key": identity_key,
            "agreement_key": agreement_key,
            "agreement_key_sig": agreement_key_sig,
            "discoverable": discoverable,
            "created_at": utcnow(),
        }
        if username is not None:
            doc["username"] = username
        await self.col.insert_one(doc)

    async def update(self, code: str, fields: dict[str, Any]) -> dict[str, Any] | None:
        if fields:
            await self.col.update_one({"code": code}, {"$set": fields})
        return await self.get(code)

    async def delete(self, code: str) -> None:
        await self.col.delete_one({"code": code})

    async def existing_codes(self, codes: list[str]) -> set[str]:
        cursor = self.col.find({"code": {"$in": codes}}, {"code": 1})
        return {doc["code"] async for doc in cursor}
