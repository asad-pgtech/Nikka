"""Registration, profile and directory lookup."""

from __future__ import annotations

import logging
from typing import Any

from pymongo.errors import DuplicateKeyError

from app.core.errors import AppError, bad_request, conflict, not_found, too_many
from app.core.security import akey_message, b64d, derive_code, verify_ed25519
from app.repositories.friendships import FriendshipRepository
from app.repositories.users import UserRepository
from app.schemas.api import MePatch, RegisterIn
from app.services.rate_limit import SlidingWindowLimiter

log = logging.getLogger(__name__)


def public_user(doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": doc["code"],
        "display_name": doc["display_name"],
        "username": doc.get("username"),
        "identity_key": doc["identity_key"],
        "agreement_key": doc["agreement_key"],
        "agreement_key_sig": doc["agreement_key_sig"],
    }


def _is_username_dup(exc: DuplicateKeyError) -> bool:
    return "username" in ((exc.details or {}).get("keyPattern") or {})


def username_taken() -> AppError:
    return conflict("username_taken", "Username is already taken")


def shows_last_seen(doc: dict[str, Any]) -> bool:
    return bool(doc.get("show_last_seen", True))


class UserService:
    def __init__(self, users: UserRepository, friendships: FriendshipRepository, lookup_limiter: SlidingWindowLimiter) -> None:
        self._users = users
        self._friendships = friendships
        self._lookup_limiter = lookup_limiter

    async def register(self, data: RegisterIn) -> bool:
        """Return True when a new user was created, False for an idempotent repeat."""
        identity = b64d(data.identity_key)
        if derive_code(identity) != data.code:
            raise bad_request("code_mismatch", "Code does not match identity key")
        if not verify_ed25519(identity, akey_message(b64d(data.agreement_key)), b64d(data.agreement_key_sig)):
            raise bad_request("invalid_signature", "Agreement key signature invalid")

        existing = await self._users.get(data.code)
        if existing is not None:
            return self._same_keys_or_conflict(existing, data)
        try:
            await self._users.create(
                code=data.code,
                display_name=data.display_name,
                username=data.username,
                identity_key=data.identity_key,
                agreement_key=data.agreement_key,
                agreement_key_sig=data.agreement_key_sig,
                discoverable=data.discoverable,
            )
        except DuplicateKeyError as exc:
            if _is_username_dup(exc):
                raise username_taken() from exc
            existing = await self._users.get(data.code)
            return self._same_keys_or_conflict(existing or {}, data)
        log.info("registered code=%s", data.code)
        return True

    @staticmethod
    def _same_keys_or_conflict(existing: dict[str, Any], data: RegisterIn) -> bool:
        if existing.get("identity_key") == data.identity_key and existing.get("agreement_key") == data.agreement_key:
            return False
        raise conflict("code_taken", "Code already registered")

    async def me(self, code: str) -> dict[str, Any]:
        doc = await self._users.get(code)
        if doc is None:
            raise not_found()
        return {
            "code": doc["code"],
            "display_name": doc["display_name"],
            "username": doc.get("username"),
            "discoverable": doc["discoverable"],
            "show_last_seen": shows_last_seen(doc),
        }

    async def update_me(self, code: str, patch: MePatch) -> dict[str, Any]:
        fields = patch.model_dump(exclude_none=True)
        try:
            await self._users.update(code, fields)
        except DuplicateKeyError as exc:
            if _is_username_dup(exc):
                raise username_taken() from exc
            raise
        return await self.me(code)

    async def lookup(self, viewer: str, *, code: str | None, username: str | None) -> dict[str, Any]:
        """Find by exact code, falling back to exact username (a username can look like a code)."""
        if not self._lookup_limiter.allow(viewer):
            raise too_many()
        doc = await self._users.get(code) if code else None
        if doc is None and username:
            doc = await self._users.get_by_username(username)
        if doc is None or await self._friendships.is_blocked(viewer, doc["code"]):
            raise not_found()
        return public_user(doc)

    async def require(self, code: str) -> dict[str, Any]:
        doc = await self._users.get(code)
        if doc is None:
            raise AppError(404, "not_found", "User not found")
        return doc
