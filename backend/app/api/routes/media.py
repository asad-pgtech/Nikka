from __future__ import annotations

from fastapi import APIRouter, Path, Request, Response, status
from fastapi.responses import FileResponse

from app.api.deps import ContainerDep, CurrentUser
from app.schemas.api import MediaCreateIn, MediaCreateOut, MediaStatusOut

router = APIRouter(prefix="/media", tags=["media"])

ChunkIndex = Path(ge=0, le=1_000_000)
_NO_STORE = {"Cache-Control": "no-store"}


@router.post("", response_model=MediaCreateOut, status_code=status.HTTP_201_CREATED)
async def create(body: MediaCreateIn, me: CurrentUser, container: ContainerDep) -> MediaCreateOut:
    blob_id = await container.media.create(me, body.to, body.size, body.chunk_count)
    return MediaCreateOut(blob_id=blob_id, chunk_bytes=container.settings.chunk_bytes)


@router.put("/{blob_id}/chunks/{index}", status_code=status.HTTP_204_NO_CONTENT)
async def put_chunk(
    blob_id: str, request: Request, me: CurrentUser, container: ContainerDep, index: int = ChunkIndex
) -> Response:
    await container.media.put_chunk(me, blob_id, index, request.stream())
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{blob_id}", response_model=MediaStatusOut)
async def blob_status(blob_id: str, me: CurrentUser, container: ContainerDep) -> MediaStatusOut:
    return MediaStatusOut(**await container.media.status(me, blob_id))


@router.post("/{blob_id}/complete")
async def complete(blob_id: str, me: CurrentUser, container: ContainerDep) -> dict[str, bool]:
    await container.media.complete(me, blob_id)
    return {"complete": True}


@router.get("/{blob_id}/chunks/{index}")
async def get_chunk(blob_id: str, me: CurrentUser, container: ContainerDep, index: int = ChunkIndex) -> FileResponse:
    path = await container.media.chunk_path(me, blob_id, index)
    return FileResponse(path, media_type="application/octet-stream", headers=_NO_STORE)


@router.post("/{blob_id}/downloaded", status_code=status.HTTP_204_NO_CONTENT)
async def downloaded(blob_id: str, me: CurrentUser, container: ContainerDep) -> Response:
    await container.media.downloaded(me, blob_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
