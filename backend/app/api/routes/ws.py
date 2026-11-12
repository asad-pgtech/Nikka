"""WebSocket endpoint: challenge-response auth, then the relay loop."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.container import Container
from app.core.security import is_valid_code, normalize_code, now_ms_, random_token
from app.services.connections import Connection
from app.services.messaging import ProtocolError
from app.services.rate_limit import TokenBucket

router = APIRouter()
log = logging.getLogger(__name__)

AUTH_TIMEOUT_SECONDS = 10
CLOSE_AUTH_FAILED = 4401
CLOSE_TOO_LARGE = 1009
FRAMES_PER_SECOND = 30
FRAME_BURST = 60


class _Reject(Exception):
    def __init__(self, close_code: int) -> None:
        self.close_code = close_code


async def _receive_frame(ws: WebSocket, max_bytes: int) -> dict[str, Any]:
    message = await ws.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    text = message.get("text")
    if text is None:
        raise ProtocolError("invalid", "Text frames only")
    if len(text) > max_bytes:
        await ws.send_json({"type": "error", "code": "payload_too_large", "message": "Frame too large"})
        raise _Reject(CLOSE_TOO_LARGE)
    try:
        frame = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProtocolError("invalid", "Malformed JSON") from exc
    if not isinstance(frame, dict) or not isinstance(frame.get("type"), str):
        raise ProtocolError("invalid", "Malformed frame")
    return frame


async def _authenticate(ws: WebSocket, container: Container) -> str | None:
    nonce = random_token(32)
    await ws.send_json({"type": "challenge", "nonce": nonce})
    try:
        frame = await asyncio.wait_for(_receive_frame(ws, 4096), AUTH_TIMEOUT_SECONDS)
    except (TimeoutError, ProtocolError):
        return None
    if frame.get("type") != "auth":
        return None
    code, signature = frame.get("code"), frame.get("signature")
    if not isinstance(code, str) or not isinstance(signature, str) or len(code) > 32 or len(signature) > 128:
        return None
    code = normalize_code(code)
    if not is_valid_code(code) or not await container.auth.verify_signature(code, nonce, signature):
        log.info("ws auth failed code=%s", code if is_valid_code(code) else "-")
        return None
    return code


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    container: Container = ws.app.state.container
    max_frame = container.settings.max_ws_frame_bytes
    await ws.accept()

    try:
        code = await _authenticate(ws, container)
    except (WebSocketDisconnect, _Reject):
        return
    if code is None:
        try:
            await ws.send_json({"type": "error", "code": "auth_failed", "message": "Authentication failed"})
            await ws.close(CLOSE_AUTH_FAILED)
        except Exception:
            pass
        return

    conn = Connection(ws, code)
    token, expires_at = container.auth.issue(code)
    await conn.send({"type": "ready", "token": token, "expires_at": expires_at, "server_time": now_ms_()})
    container.manager.add(conn)
    await container.presence.broadcast()

    bucket = TokenBucket(FRAMES_PER_SECOND, FRAME_BURST)
    try:
        while True:
            try:
                frame = await _receive_frame(ws, max_frame)
                if not bucket.take():
                    raise ProtocolError("rate_limited", "Slow down")
                await container.messaging.handle(conn, frame)
            except ProtocolError as err:
                await conn.send(err.frame())
    except (WebSocketDisconnect, _Reject):
        pass
    finally:
        container.manager.remove(conn)
        await container.presence.broadcast()
        try:
            await ws.close()
        except Exception:
            pass
