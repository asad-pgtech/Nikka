from __future__ import annotations

from fastapi import APIRouter, Response, status

from app.api.deps import ContainerDep, CurrentUser
from app.core.errors import not_found
from app.core.security import is_valid_code, is_valid_username, normalize_code, normalize_username
from app.schemas.api import MeOut, MePatch, PublicUser

router = APIRouter(tags=["users"])


@router.get("/me", response_model=MeOut)
async def get_me(me: CurrentUser, container: ContainerDep) -> MeOut:
    return MeOut(**await container.users.me(me))


@router.patch("/me", response_model=MeOut)
async def patch_me(body: MePatch, me: CurrentUser, container: ContainerDep) -> MeOut:
    result = await container.users.update_me(me, body)
    await container.presence.broadcast()
    if body.show_last_seen is not None:
        await container.presence.notify_friends(me)
    return MeOut(**result)


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_me(me: CurrentUser, container: ContainerDep) -> Response:
    await container.account.delete(me)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/users/{query}", response_model=PublicUser)
async def lookup(query: str, me: CurrentUser, container: ContainerDep) -> PublicUser:
    """Exact code (`XXXX-XXXX-XXXX`) or username (`name` / `@name`)."""
    query = query[:32]
    code = None if query.startswith("@") else normalize_code(query)
    username = normalize_username(query)
    code = code if code and is_valid_code(code) else None
    username = username if is_valid_username(username) else None
    if code is None and username is None:
        raise not_found()
    return PublicUser(**await container.users.lookup(me, code=code, username=username))
