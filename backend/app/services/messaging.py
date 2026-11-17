"""Store-and-forward relay for encrypted envelopes and receipts.

Every item is persisted before live delivery, so a crash between the two
never loses a message; clients de-duplicate by `msg_id`/`qid`.
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from app.core.clock import to_ms, utcnow
from app.core.config import Settings
from app.core.security import b64d, is_valid_code, normalize_code, random_token
from app.repositories.queue import QueueRepository
from app.services.connections import Connection, ConnectionManager
from app.services.friends import FriendService
from app.services.push import PushService

log = logging.getLogger(__name__)

MSG_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SYNC_PAGE = 200
MAX_IDS = 200
MAX_ACK = 500


class ProtocolError(Exception):
    def __init__(self, code: str, message: str, ref_id: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.message = message
        self.ref_id = ref_id

    def frame(self) -> dict[str, Any]:
        out: dict[str, Any] = {"type": "error", "code": self.code, "message": self.message}
        if self.ref_id is not None:
            out["id"] = self.ref_id
        return out


def serialize_item(doc: dict[str, Any]) -> dict[str, Any]:
    item: dict[str, Any] = {"qid": doc["qid"], "kind": doc["kind"], "from": doc["from"], "ts": to_ms(doc["created_at"])}
    for key in ("msg_id", "msg_ids", "payload", "ref"):
        if doc.get(key) is not None:
            item[key] = doc[key]
    return item


def _code(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 32:
        raise ProtocolError("invalid", "Invalid code")
    code = normalize_code(value)
    if not is_valid_code(code):
        raise ProtocolError("invalid", "Invalid code")
    return code


def _msg_id(value: Any) -> str:
    if not isinstance(value, str) or not MSG_ID_RE.match(value):
        raise ProtocolError("invalid", "Invalid message id")
    return value


class MessagingService:
    def __init__(
        self,
        settings: Settings,
        queue: QueueRepository,
        friends: FriendService,
        manager: ConnectionManager,
        push: PushService,
    ) -> None:
        self._settings = settings
        self._queue = queue
        self._friends = friends
        self._manager = manager
        self._push = push

    async def handle(self, conn: Connection, frame: dict[str, Any]) -> None:
        kind = frame.get("type")
        handler = {
            "send": self._send,
            "ack": self._ack,
            "read": self._read,
            "typing": self._typing,
            "sync": self._sync,
            "ping": self._ping,
        }.get(kind)  # type: ignore[arg-type]
        if handler is None:
            raise ProtocolError("unknown_type", "Unknown frame type")
        await handler(conn, frame)

    # --- handlers -----------------------------------------------------------------
    async def _ping(self, conn: Connection, _: dict[str, Any]) -> None:
        await conn.send({"type": "pong"})

    async def _sync(self, conn: Connection, _: dict[str, Any]) -> None:
        docs, more = await self._queue.page(conn.code, conn.sync_cursor, SYNC_PAGE)
        if docs:
            conn.sync_cursor = docs[-1]["_id"]
        await conn.send({"type": "sync", "items": [serialize_item(d) for d in docs], "more": more})

    async def _send(self, conn: Connection, frame: dict[str, Any]) -> None:
        raw_id = frame.get("id")
        ref_id = raw_id if isinstance(raw_id, str) and MSG_ID_RE.match(raw_id) else None
        try:
            msg_id = _msg_id(raw_id)
            to = _code(frame.get("to"))
            payload = frame.get("payload")
            if not isinstance(payload, str) or not payload:
                raise ProtocolError("invalid", "Missing payload")
            if len(payload) > self._settings.max_ws_frame_bytes:
                raise ProtocolError("payload_too_large", "Payload too large")
            try:
                size = len(b64d(payload))
            except ValueError as exc:
                raise ProtocolError("invalid", "Payload must be base64url") from exc
            if size > self._settings.max_payload_bytes:
                raise ProtocolError("payload_too_large", "Payload too large")
            if size < 12 + 16:
                raise ProtocolError("invalid", "Malformed envelope")
            silent = frame.get("silent", False)
            if not isinstance(silent, bool):
                raise ProtocolError("invalid", "Invalid silent flag")
            if not await self._friends.are_friends(conn.code, to):
                raise ProtocolError("not_friends", "Not friends")
        except ProtocolError as err:
            err.ref_id = ref_id
            raise

        doc = await self._queue.insert(
            {
                "qid": uuid.uuid4().hex,
                "kind": "msg",
                "to": to,
                "from": conn.code,
                "msg_id": msg_id,
                "payload": payload,
                "ref": random_token(16),
                "created_at": utcnow(),
                "delivered": False,
            }
        )
        await conn.send({"type": "sent", "id": msg_id, "ts": to_ms(doc["created_at"])})
        await self._deliver(doc, push=not silent)

    async def _ack(self, conn: Connection, frame: dict[str, Any]) -> None:
        qids = frame.get("qids")
        if not isinstance(qids, list) or len(qids) > MAX_ACK or not all(
            isinstance(q, str) and 0 < len(q) <= 64 for q in qids
        ):
            raise ProtocolError("invalid", "Invalid qids")
        for doc in await self._queue.take(conn.code, qids):
            if doc["kind"] != "msg":
                continue
            if not await self._friends.are_friends(conn.code, doc["from"]):
                continue
            receipt = await self._queue.insert(
                {
                    "qid": uuid.uuid4().hex,
                    "kind": "delivered",
                    "to": doc["from"],
                    "from": conn.code,
                    "msg_id": doc["msg_id"],
                    "created_at": utcnow(),
                    "delivered": False,
                }
            )
            await self._deliver(receipt, push=False)

    async def _read(self, conn: Connection, frame: dict[str, Any]) -> None:
        to = _code(frame.get("to"))
        ids = frame.get("ids")
        if not isinstance(ids, list) or not 0 < len(ids) <= MAX_IDS:
            raise ProtocolError("invalid", "Invalid ids")
        msg_ids = [_msg_id(i) for i in ids]
        if not await self._friends.are_friends(conn.code, to):
            raise ProtocolError("not_friends", "Not friends")
        doc = await self._queue.insert(
            {
                "qid": uuid.uuid4().hex,
                "kind": "read",
                "to": to,
                "from": conn.code,
                "msg_ids": msg_ids,
                "created_at": utcnow(),
                "delivered": False,
            }
        )
        await self._deliver(doc, push=False)

    async def _typing(self, conn: Connection, frame: dict[str, Any]) -> None:
        to = _code(frame.get("to"))
        active = frame.get("active")
        if not isinstance(active, bool):
            raise ProtocolError("invalid", "Invalid typing state")
        if self._manager.is_online(to) and await self._friends.are_friends(conn.code, to):
            await self._manager.send_to(to, {"type": "typing", "from": conn.code, "active": active})

    # --- delivery -----------------------------------------------------------------
    async def _deliver(self, doc: dict[str, Any], push: bool) -> None:
        to = doc["to"]
        if self._manager.is_online(to):
            await self._manager.send_to(to, {"type": "item", "item": serialize_item(doc)})
        elif push:
            self._push.notify(to, doc["ref"])
