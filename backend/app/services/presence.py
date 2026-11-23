"""Presence: personalized online lists pushed to every connected user."""

from __future__ import annotations

import asyncio

from app.core.clock import to_ms, utcnow
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

    async def went_offline(self, code: str) -> None:
        """Record when `code` closed its last socket and tell online friends (if both share last seen)."""
        doc = await self._users.update(code, {"last_seen": utcnow()})
        if doc is None or not doc.get("show_last_seen", True):
            return
        frame = {"type": "last_seen", "code": code, "ts": to_ms(doc["last_seen"])}
        for viewer in await self._online_friends(code):
            viewer_doc = await self._users.get(viewer)
            if viewer_doc is not None and viewer_doc.get("show_last_seen", True):
                await self._manager.send_to(viewer, frame)

    async def notify_friends(self, code: str) -> None:
        """Ask online friends to refetch their friend list (e.g. after a privacy change)."""
        for viewer in await self._online_friends(code):
            await self._manager.send_to(viewer, {"type": "friends_changed"})

    async def _online_friends(self, code: str) -> list[str]:
        out = []
        for rel in await self._friendships.for_user(code):
            if rel["status"] != "accepted":
                continue
            other = next(u for u in rel["users"] if u != code)
            if self._manager.is_online(other):
                out.append(other)
        return out
