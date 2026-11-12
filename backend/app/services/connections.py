"""In-memory registry of authenticated WebSocket connections.

State lives in process memory, so the API must run as a single worker
(see Dockerfile). A user may have several sockets (e.g. two tabs).
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any

from bson import ObjectId
from starlette.websockets import WebSocket

log = logging.getLogger(__name__)


class Connection:
    def __init__(self, ws: WebSocket, code: str) -> None:
        self.ws = ws
        self.code = code
        self.sync_cursor: ObjectId | None = None
        self._send_lock = asyncio.Lock()

    async def send(self, message: dict[str, Any]) -> bool:
        async with self._send_lock:
            try:
                await self.ws.send_json(message)
                return True
            except Exception:  # socket already gone; the reader loop cleans up
                return False

    async def close(self, code: int = 1000) -> None:
        try:
            await self.ws.close(code=code)
        except Exception:
            pass


class ConnectionManager:
    def __init__(self) -> None:
        self._by_code: dict[str, set[Connection]] = defaultdict(set)

    def add(self, conn: Connection) -> None:
        self._by_code[conn.code].add(conn)
        log.info("connected code=%s sockets=%d", conn.code, len(self._by_code[conn.code]))

    def remove(self, conn: Connection) -> None:
        conns = self._by_code.get(conn.code)
        if conns is None:
            return
        conns.discard(conn)
        if not conns:
            del self._by_code[conn.code]
        log.info("disconnected code=%s", conn.code)

    def is_online(self, code: str) -> bool:
        return bool(self._by_code.get(code))

    def online_codes(self) -> list[str]:
        return list(self._by_code)

    def connections(self, code: str) -> list[Connection]:
        return list(self._by_code.get(code, ()))

    async def send_to(self, code: str, message: dict[str, Any]) -> int:
        conns = self.connections(code)
        results = await asyncio.gather(*(c.send(message) for c in conns))
        return sum(results)

    async def close_user(self, code: str, close_code: int = 4403) -> None:
        for conn in self.connections(code):
            await conn.close(close_code)

    async def close_all(self) -> None:
        for code in self.online_codes():
            await self.close_user(code, 1001)
