"""Friend requests, acceptance, blocking. Source of truth for relay permissions."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from app.core.clock import to_ms, utcnow
from app.core.config import Settings
from app.core.errors import AppError, bad_request, conflict, not_found, too_many
from app.core.security import friend_statement, ts_fresh, verify_ed25519_b64
from app.repositories.friendships import FriendshipRepository
from app.repositories.misc import RequestLogRepository
from app.repositories.users import UserRepository
from app.services.connections import ConnectionManager
from app.services.presence import PresenceService
from app.services.users import public_user, shows_last_seen

log = logging.getLogger(__name__)


class FriendService:
    def __init__(
        self,
        settings: Settings,
        users: UserRepository,
        friendships: FriendshipRepository,
        request_log: RequestLogRepository,
        manager: ConnectionManager,
        presence: PresenceService,
    ) -> None:
        self._settings = settings
        self._users = users
        self._friendships = friendships
        self._log = request_log
        self._manager = manager
        self._presence = presence

    # --- queries ---------------------------------------------------------------
    async def are_friends(self, a: str, b: str) -> bool:
        return a != b and await self._friendships.are_friends(a, b)

    async def list_for(self, me: str) -> list[dict[str, Any]]:
        docs = await self._friendships.for_user(me)
        peers = await self._users.get_many([u for d in docs for u in d["users"] if u != me])
        me_doc = await self._users.get(me)
        i_share = me_doc is not None and shows_last_seen(me_doc)
        out: list[dict[str, Any]] = []
        for doc in docs:
            peer_code = next(u for u in doc["users"] if u != me)
            peer = peers.get(peer_code)
            if peer is None:
                continue
            status = doc["status"]
            blocked_by_me = me in doc.get("blocked_by", [])
            if status == "blocked" and not blocked_by_me:
                continue
            if status == "declined" and doc["requester"] != me:
                continue
            out.append(
                {
                    **public_user(peer),
                    "status": status,
                    "direction": "outgoing" if doc["requester"] == me else "incoming",
                    "blocked_by_me": blocked_by_me,
                    "request_ts": doc.get("request_ts"),
                    "request_sig": doc.get("request_sig"),
                    "accept_ts": doc.get("accept_ts"),
                    "accept_sig": doc.get("accept_sig"),
                    "updated_at": to_ms(doc.get("updated_at")) or 0,
                    "last_seen": (
                        to_ms(peer.get("last_seen"))
                        if status == "accepted" and i_share and shows_last_seen(peer)
                        else None
                    ),
                }
            )
        return out

    # --- commands --------------------------------------------------------------
    async def request(self, me: str, to: str, ts: int, signature: str) -> None:
        if me == to:
            raise bad_request("self", "Cannot befriend yourself")
        sender = await self._require_user(me)
        if await self._users.get(to) is None:
            raise not_found()

        existing = await self._friendships.get(me, to)
        now = utcnow()
        if existing is not None:
            status = existing["status"]
            if status == "blocked":
                raise not_found()
            if status == "accepted":
                raise conflict("already_friends")
            if status == "pending":
                raise conflict("already_pending" if existing["requester"] == me else "incoming_pending")
            if status == "declined" and existing["requester"] == me:
                until = existing.get("cooldown_until")
                if until is not None and until > now:
                    raise too_many("cooldown", "Please wait before requesting again")

        if await self._log.count_last_day(me) >= self._settings.request_daily_cap:
            raise too_many("daily_cap", "Daily friend request limit reached")
        self._verify_statement("freq", sender, to, ts, signature)

        await self._log.record(me, to)
        await self._friendships.replace(
            me,
            to,
            {
                "requester": me,
                "recipient": to,
                "status": "pending",
                "blocked_by": [],
                "request_ts": ts,
                "request_sig": signature,
                "accept_ts": None,
                "accept_sig": None,
                "cooldown_until": None,
                "created_at": now,
                "updated_at": now,
            },
        )
        log.info("friend request from=%s to=%s", me, to)
        await self._changed(me, to)

    async def accept(self, me: str, requester: str, ts: int, signature: str) -> None:
        await self._pending_for_recipient(me, requester)
        accepter = await self._require_user(me)
        self._verify_statement("facc", accepter, requester, ts, signature)
        await self._friendships.update(
            me,
            requester,
            {"$set": {"status": "accepted", "accept_ts": ts, "accept_sig": signature, "updated_at": utcnow()}},
        )
        log.info("friend accepted by=%s of=%s", me, requester)
        await self._changed(me, requester, presence=True)

    async def decline(self, me: str, requester: str) -> None:
        await self._pending_for_recipient(me, requester)
        now = utcnow()
        await self._friendships.update(
            me,
            requester,
            {
                "$set": {
                    "status": "declined",
                    "updated_at": now,
                    "cooldown_until": now + timedelta(hours=self._settings.request_cooldown_hours),
                }
            },
        )
        await self._changed(me, requester)

    async def cancel(self, me: str, recipient: str) -> None:
        doc = await self._friendships.get(me, recipient)
        if doc is None or doc["status"] != "pending" or doc["requester"] != me:
            raise not_found("No pending request")
        await self._friendships.delete(me, recipient)
        await self._changed(me, recipient)

    async def block(self, me: str, other: str) -> None:
        if me == other:
            raise bad_request("self", "Cannot block yourself")
        if await self._users.get(other) is None:
            raise not_found()
        doc = await self._friendships.get(me, other)
        now = utcnow()
        if doc is None:
            await self._friendships.replace(
                me,
                other,
                {
                    "requester": me,
                    "recipient": other,
                    "status": "blocked",
                    "blocked_by": [me],
                    "request_ts": None,
                    "request_sig": None,
                    "accept_ts": None,
                    "accept_sig": None,
                    "cooldown_until": None,
                    "created_at": now,
                    "updated_at": now,
                },
            )
        else:
            await self._friendships.update(
                me, other, {"$set": {"status": "blocked", "updated_at": now}, "$addToSet": {"blocked_by": me}}
            )
        log.info("block by=%s", me)
        await self._changed(me, other, presence=True)

    async def unblock(self, me: str, other: str) -> None:
        doc = await self._friendships.get(me, other)
        if doc is None or me not in doc.get("blocked_by", []):
            return
        remaining = [c for c in doc["blocked_by"] if c != me]
        if remaining:
            await self._friendships.update(me, other, {"$set": {"blocked_by": remaining, "updated_at": utcnow()}})
        else:
            await self._friendships.delete(me, other)
        await self._changed(me, other, presence=True)

    # --- helpers ---------------------------------------------------------------
    async def _require_user(self, code: str) -> dict[str, Any]:
        user = await self._users.get(code)
        if user is None:
            raise AppError(401, "unauthorized", "Unknown user")
        return user

    async def _pending_for_recipient(self, me: str, requester: str) -> dict[str, Any]:
        doc = await self._friendships.get(me, requester)
        if doc is None or doc["status"] != "pending" or doc["recipient"] != me:
            raise not_found("No pending request")
        return doc

    @staticmethod
    def _verify_statement(kind: str, signer: dict[str, Any], other: str, ts: int, signature: str) -> None:
        if not ts_fresh(ts):
            raise bad_request("stale", "Timestamp outside allowed window")
        message = friend_statement(kind, signer["code"], other, signer["identity_key"], signer["agreement_key"], ts)
        if not verify_ed25519_b64(signer["identity_key"], message, signature):
            raise bad_request("invalid_signature", "Signature invalid")

    async def _changed(self, a: str, b: str, presence: bool = False) -> None:
        for code in (a, b):
            await self._manager.send_to(code, {"type": "friends_changed"})
        if presence:
            await self._presence.broadcast()
