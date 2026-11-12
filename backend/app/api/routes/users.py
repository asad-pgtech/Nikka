from __future__ import annotations

from fastapi import APIRouter, Response, status

from app.api.deps import ContainerDep, CurrentUser
from app.core.errors import not_found
from app.core.security import is_valid_code, normalize_code
from app.schemas.api import MeOut, MePatch, PublicUser

router = APIRouter(tags=["users"])


@router.get("/me", response_model=MeOut)
async def get_me(me: CurrentUser, container: ContainerDep) -> MeOut:
    return MeOut(**await container.users.me(me))


@router.patch("/me", response_model=MeOut)
async def patch_me(body: MePatch, me: CurrentUser, container: ContainerDep) -> MeOut:
    result = await container.users.update_me(me, body)
    await container.presence.broadcast()
    return MeOut(**result)


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_me(me: CurrentUser, container: ContainerDep) -> Response:
    await container.account.delete(me)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/users/{code}", response_model=PublicUser)
async def lookup(code: str, me: CurrentUser, container: ContainerDep) -> PublicUser:
    normalized = normalize_code(code[:32])
    if not is_valid_code(normalized):
        raise not_found()
    return PublicUser(**await container.users.lookup(me, normalized))
