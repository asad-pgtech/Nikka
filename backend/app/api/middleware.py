"""Request body size limits (pure ASGI, streaming-safe)."""

from __future__ import annotations

import json
import re

from starlette.types import ASGIApp, Message, Receive, Scope, Send

_CHUNK_PATH = re.compile(r"^/api/media/[^/]+/chunks/\d+$")


class _TooLarge(Exception):
    pass


class BodySizeLimitMiddleware:
    def __init__(self, app: ASGIApp, default_limit: int, chunk_limit: int) -> None:
        self.app = app
        self.default_limit = default_limit
        self.chunk_limit = chunk_limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self.chunk_limit if _CHUNK_PATH.match(scope["path"]) else self.default_limit
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    if int(value) > limit:
                        await self._reject(send)
                        return
                except ValueError:
                    await self._reject(send, 400, "invalid")
                    return

        received = 0
        started = False

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _TooLarge
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _TooLarge:
            if not started:
                await self._reject(send)

    @staticmethod
    async def _reject(send: Send, status: int = 413, code: str = "too_large") -> None:
        body = json.dumps({"detail": {"code": code, "message": "Request body too large"}}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})
