"""Web Push dispatch. Payload is only an opaque reference; content is never sent."""

from __future__ import annotations

import asyncio
import json
import logging
from functools import partial
from typing import Any

import anyio
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from app.core.config import Settings
from app.repositories.push import PushRepository

log = logging.getLogger(__name__)

PUSH_TTL_SECONDS = 24 * 60 * 60
_GONE = {404, 410}


class PushService:
    def __init__(self, settings: Settings, repo: PushRepository) -> None:
        self._settings = settings
        self._repo = repo
        self._vapid: Vapid | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        if settings.push_enabled:
            self._vapid = Vapid.from_string(settings.vapid_private_key)
        else:
            log.warning("VAPID keys not configured; push notifications disabled")

    @property
    def enabled(self) -> bool:
        return self._vapid is not None

    def notify(self, code: str, ref: str) -> None:
        """Fire-and-forget push to all of a user's subscriptions."""
        if not self.enabled:
            return
        task = asyncio.create_task(self._send_all(code, ref))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def send_test(self, code: str, ref: str) -> list[int | None]:
        """Push to the caller's own subscriptions and return the push-service status codes."""
        if not self.enabled:
            return []
        return await self._send_all(code, ref)

    async def _send_all(self, code: str, ref: str) -> list[int | None]:
        data = json.dumps({"ref": ref})
        statuses: list[int | None] = []
        for sub in await self._repo.for_user(code):
            status = await anyio.to_thread.run_sync(partial(self._send_one, sub, data))
            statuses.append(status)
            if status in _GONE:
                await self._repo.delete(sub["endpoint"])
                log.info("push subscription removed code=%s status=%s", code, status)
            elif status is None or status >= 400 or status == 0:
                log.warning("push failed code=%s status=%s", code, status)
            else:
                log.info("push sent code=%s status=%s", code, status)
        return statuses

    def _send_one(self, sub: dict[str, Any], data: str) -> int | None:
        try:
            response = webpush(
                subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                data=data,
                vapid_private_key=self._vapid,
                vapid_claims={"sub": self._settings.vapid_subject},
                ttl=PUSH_TTL_SECONDS,
                # No "Topic" header: Apple rejects it (400 BadWebPushTopic). The SW tag collapses repeats.
                headers={"Urgency": "high"},
                timeout=10,
            )
            return getattr(response, "status_code", None)
        except WebPushException as exc:
            return exc.response.status_code if exc.response is not None else 0
        except Exception:  # network errors etc.; never log subscription data
            log.warning("push transport error")
            return 0

    async def drain(self) -> None:
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
