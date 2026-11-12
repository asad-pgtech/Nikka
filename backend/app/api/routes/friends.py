from __future__ import annotations

from fastapi import APIRouter, status

from app.api.deps import ContainerDep, CurrentUser
from app.core.errors import not_found
from app.core.security import is_valid_code, normalize_code
from app.schemas.api import FriendAcceptIn, FriendRequestIn, FriendsOut, StatusOut

router = APIRouter(prefix="/friends", tags=["friends"])


def _peer(code: str) -> str:
    normalized = normalize_code(code[:32])
    if not is_valid_code(normalized):
        raise not_found()
    return normalized


@router.get("", response_model=FriendsOut)
async def list_friends(me: CurrentUser, container: ContainerDep) -> FriendsOut:
    return FriendsOut.model_validate({"friends": await container.friends.list_for(me)})


@router.post("/request", response_model=StatusOut, status_code=status.HTTP_201_CREATED)
async def request(body: FriendRequestIn, me: CurrentUser, container: ContainerDep) -> StatusOut:
    await container.friends.request(me, body.to, body.ts, body.signature)
    return StatusOut(status="pending")


@router.post("/{code}/accept", response_model=StatusOut)
async def accept(code: str, body: FriendAcceptIn, me: CurrentUser, container: ContainerDep) -> StatusOut:
    await container.friends.accept(me, _peer(code), body.ts, body.signature)
    return StatusOut(status="accepted")


@router.post("/{code}/decline", response_model=StatusOut)
async def decline(code: str, me: CurrentUser, container: ContainerDep) -> StatusOut:
    await container.friends.decline(me, _peer(code))
    return StatusOut(status="declined")


@router.post("/{code}/cancel", response_model=StatusOut)
async def cancel(code: str, me: CurrentUser, container: ContainerDep) -> StatusOut:
    await container.friends.cancel(me, _peer(code))
    return StatusOut(status="cancelled")


@router.post("/{code}/block", response_model=StatusOut)
async def block(code: str, me: CurrentUser, container: ContainerDep) -> StatusOut:
    await container.friends.block(me, _peer(code))
    return StatusOut(status="blocked")


@router.post("/{code}/unblock", response_model=StatusOut)
async def unblock(code: str, me: CurrentUser, container: ContainerDep) -> StatusOut:
    await container.friends.unblock(me, _peer(code))
    return StatusOut(status="none")
