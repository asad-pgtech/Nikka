"""Presence: personalized online lists pushed to every connected user."""

from __future__ import annotations

import asyncio

from app.repositories.friendships import FriendshipRepository
from app.repositories.users import UserRepository
from app.services.connections import ConnectionManager


class PresenceService:
    def __init__(self, manager: ConnectionManager, users: UserRepository, friendships: FriendshipRepository) -> None:
        self._manager = manager
        self._users = users
        self._friendships = friendships
        self._lock = asyncio.Lock()

    async def broadcast(self) -> None:
        async with self._lock:
            online = self._manager.online_codes()
            if not online:
                return
            users = await self._users.get_many(online)
            friends: set[frozenset[str]] = set()
            blocked: set[frozenset[str]] = set()
            for rel in await self._friendships.among(online):
                pair = frozenset(rel["users"])
                (friends if rel["status"] == "accepted" else blocked).add(pair)

            visible = [u for u in online if users.get(u, {}).get("discoverable")]
            for viewer in online:
                entries = []
                for code in visible:
                    pair = frozenset((viewer, code))
                    if code == viewer or pair in blocked:
                        continue
                    entries.append(
                        {"code": code, "display_name": users[code]["display_name"], "friend": pair in friends}
                    )
                await self._manager.send_to(viewer, {"type": "presence", "users": entries})
