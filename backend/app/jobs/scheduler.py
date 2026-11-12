"""Periodic maintenance jobs, run in-process on an interval."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import timedelta

from app.container import Container
from app.core.clock import utcnow

log = logging.getLogger(__name__)


async def purge_queue(c: Container) -> int:
    """Delete delivered items and items never fetched within QUEUE_TTL_DAYS."""
    return await c.queue_repo.purge(utcnow() - timedelta(days=c.settings.queue_ttl_days))


async def expire_media(c: Container) -> int:
    return await c.media.expire()


async def clean_push_subscriptions(c: Container) -> int:
    """Remove subscriptions whose owner no longer exists (404/410 are removed on send)."""
    owners = await c.push_repo.owner_codes()
    existing = await c.users_repo.existing_codes(list(owners))
    return await c.push_repo.delete_for_codes(owners - existing)


async def prune_rate_limits(c: Container) -> int:
    c.lookup_limiter.prune()
    return 0  # friend-request log expires through a Mongo TTL index


JOBS = (purge_queue, expire_media, clean_push_subscriptions, prune_rate_limits)


async def run_all(c: Container) -> None:
    for job in JOBS:
        try:
            count = await job(c)
            if count:
                log.info("job %s removed=%d", job.__name__, count)
        except Exception:
            log.exception("job %s failed", job.__name__)


class Scheduler:
    def __init__(self, container: Container) -> None:
        self._container = container
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="maintenance-jobs")

    async def _loop(self) -> None:
        while True:
            await run_all(self._container)
            await asyncio.sleep(self._container.settings.job_interval_seconds)

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
