"""Account deletion across every collection and the media store."""

from __future__ import annotations

import logging

from app.repositories.friendships import FriendshipRepository
from app.repositories.push import PushRepository
from app.repositories.queue import QueueRepository
from app.repositories.users import UserRepository
from app.services.connections import ConnectionManager
from app.services.media import MediaService
from app.services.presence import PresenceService

log = logging.getLogger(__name__)


class AccountService:
    def __init__(
        self,
        users: UserRepository,
        friendships: FriendshipRepository,
        queue: QueueRepository,
        push: PushRepository,
        media: MediaService,
        manager: ConnectionManager,
        presence: PresenceService,
    ) -> None:
        self._users = users
        self._friendships = friendships
        self._queue = queue
        self._push = push
        self._media = media
        self._manager = manager
        self._presence = presence

    async def delete(self, code: str) -> None:
        await self._manager.close_user(code)
        peers = await self._friendships.delete_for_user(code)
        await self._queue.delete_for_user(code)
        await self._media.delete_for_user(code)
        await self._push.delete_for_user(code)
        await self._users.delete(code)
        for peer in set(peers):
            await self._manager.send_to(peer, {"type": "friends_changed"})
        await self._presence.broadcast()
        log.info("account deleted code=%s", code)
