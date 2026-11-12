"""FastAPI application factory."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.middleware import BodySizeLimitMiddleware
from app.api.routes import auth, friends, media, push, system, users, ws
from app.container import build_container
from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.core.logging import configure_logging
from app.db.mongo import create_client, ensure_indexes
from app.jobs.scheduler import Scheduler

log = logging.getLogger(__name__)

JSON_BODY_LIMIT = 64 * 1024


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        client = create_client(settings.mongo_url)
        container = build_container(settings, client)
        await ensure_indexes(container.db)
        container.media.ensure_storage()
        app.state.container = container
        scheduler = Scheduler(container)
        scheduler.start()
        log.info("api started")
        try:
            yield
        finally:
            await scheduler.stop()
            await container.manager.close_all()
            await container.push.drain()
            await client.close()
            log.info("api stopped")

    app = FastAPI(
        title="LAN Chat API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(
        BodySizeLimitMiddleware,
        default_limit=JSON_BODY_LIMIT,
        chunk_limit=settings.max_chunk_body_bytes,
    )

    @app.exception_handler(AppError)
    async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content={"detail": {"code": exc.code, "message": exc.message}})

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Echo field locations only; never the submitted values.
        fields = ".".join(str(p) for p in exc.errors()[0]["loc"]) if exc.errors() else ""
        return JSONResponse(
            status_code=422, content={"detail": {"code": "invalid", "message": f"Invalid field: {fields}"}}
        )

    for router in (system.router, auth.router, users.router, friends.router, media.router, push.router, ws.router):
        app.include_router(router, prefix="/api")
    return app


app = create_app()
