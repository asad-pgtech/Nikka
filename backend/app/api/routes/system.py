from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import ContainerDep
from app.schemas.api import ConfigOut

router = APIRouter(tags=["system"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/config", response_model=ConfigOut)
async def config(container: ContainerDep) -> ConfigOut:
    s = container.settings
    return ConfigOut(
        max_file_bytes=s.max_file_bytes,
        chunk_bytes=s.chunk_bytes,
        max_payload_bytes=s.max_payload_bytes,
        autolock_default_seconds=s.autolock_default_seconds,
        media_ttl_days=s.media_ttl_days,
        vapid_public_key=s.vapid_public_key if s.push_enabled else None,
    )
