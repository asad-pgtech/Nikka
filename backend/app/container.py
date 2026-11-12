"""Composition root: wires repositories and services for one app instance."""

from __future__ import annotations

from dataclasses import dataclass

from pymongo import AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase

from app.core.config import Settings
from app.core.security import TokenSigner
from app.repositories.friendships import FriendshipRepository
from app.repositories.media import MediaRepository
from app.repositories.misc import NonceRepository, RequestLogRepository
from app.repositories.push import PushRepository
from app.repositories.queue import QueueRepository
from app.repositories.users import UserRepository
from app.services.account import AccountService
from app.services.auth import AuthService
from app.services.connections import ConnectionManager
from app.services.friends import FriendService
from app.services.media import MediaService
from app.services.messaging import MessagingService
from app.services.presence import PresenceService
from app.services.push import PushService
from app.services.rate_limit import SlidingWindowLimiter
from app.services.users import UserService


@dataclass
class Container:
    settings: Settings
    client: AsyncMongoClient
    db: AsyncDatabase
    users_repo: UserRepository
    friendships_repo: FriendshipRepository
    queue_repo: QueueRepository
    media_repo: MediaRepository
    push_repo: PushRepository
    manager: ConnectionManager
    presence: PresenceService
    auth: AuthService
    users: UserService
    friends: FriendService
    push: PushService
    messaging: MessagingService
    media: MediaService
    account: AccountService
    lookup_limiter: SlidingWindowLimiter


def build_container(settings: Settings, client: AsyncMongoClient) -> Container:
    db = client[settings.mongo_db]
    users_repo = UserRepository(db)
    friendships_repo = FriendshipRepository(db)
    queue_repo = QueueRepository(db)
    media_repo = MediaRepository(db)
    push_repo = PushRepository(db)

    manager = ConnectionManager()
    presence = PresenceService(manager, users_repo, friendships_repo)
    signer = TokenSigner(settings.session_secret or "", settings.session_ttl_minutes * 60)
    lookup_limiter = SlidingWindowLimiter(settings.lookup_per_minute, 60)

    auth = AuthService(users_repo, NonceRepository(db), signer)
    users = UserService(users_repo, friendships_repo, lookup_limiter)
    friends = FriendService(settings, users_repo, friendships_repo, RequestLogRepository(db), manager, presence)
    push = PushService(settings, push_repo)
    messaging = MessagingService(settings, queue_repo, friends, manager, push)
    media = MediaService(settings, media_repo, friends)
    account = AccountService(users_repo, friendships_repo, queue_repo, push_repo, media, manager, presence)

    return Container(
        settings=settings,
        client=client,
        db=db,
        users_repo=users_repo,
        friendships_repo=friendships_repo,
        queue_repo=queue_repo,
        media_repo=media_repo,
        push_repo=push_repo,
        manager=manager,
        presence=presence,
        auth=auth,
        users=users,
        friends=friends,
        push=push,
        messaging=messaging,
        media=media,
        account=account,
        lookup_limiter=lookup_limiter,
    )
