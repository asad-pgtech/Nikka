"""MongoDB client lifecycle and index management."""

from __future__ import annotations

import logging

from pymongo import ASCENDING, AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase

log = logging.getLogger(__name__)


class Collections:
    USERS = "users"
    FRIENDSHIPS = "friendships"
    QUEUE = "queued_messages"
    MEDIA = "media_blobs"
    PUSH = "push_subscriptions"
    REQUEST_LOG = "request_log"
    NONCES = "auth_nonces"


def create_client(url: str) -> AsyncMongoClient:
    return AsyncMongoClient(url, tz_aware=True, serverSelectionTimeoutMS=5000)


async def ensure_indexes(db: AsyncDatabase) -> None:
    await db[Collections.USERS].create_index("code", unique=True)
    await db[Collections.USERS].create_index(
        "username", unique=True, partialFilterExpression={"username": {"$type": "string"}}, name="uniq_username"
    )

    friendships = db[Collections.FRIENDSHIPS]
    await friendships.create_index("pair", unique=True)
    await friendships.create_index("users")

    queue = db[Collections.QUEUE]
    await queue.create_index([("to", ASCENDING), ("_id", ASCENDING)])
    await queue.create_index("created_at")
    await queue.create_index("qid", unique=True)
    await queue.create_index(
        [("to", ASCENDING), ("from", ASCENDING), ("msg_id", ASCENDING)],
        unique=True,
        partialFilterExpression={"kind": "msg"},
        name="uniq_msg_per_sender",
    )

    media = db[Collections.MEDIA]
    await media.create_index("blob_id", unique=True)
    await media.create_index("created_at")

    push = db[Collections.PUSH]
    await push.create_index("endpoint", unique=True)
    await push.create_index("code")

    await db[Collections.REQUEST_LOG].create_index("created_at", expireAfterSeconds=86400)
    await db[Collections.REQUEST_LOG].create_index("code")
    await db[Collections.NONCES].create_index("expires_at", expireAfterSeconds=0)
    await db[Collections.NONCES].create_index("nonce", unique=True)
    log.info("mongo indexes ensured")
