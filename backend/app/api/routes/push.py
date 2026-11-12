from __future__ import annotations

import secrets

from fastapi import APIRouter, Response, status

from app.api.deps import ContainerDep, CurrentUser
from app.schemas.api import PushSubscribeIn, PushUnsubscribeIn

router = APIRouter(prefix="/push", tags=["push"])


@router.post("/subscribe", status_code=status.HTTP_204_NO_CONTENT)
async def subscribe(body: PushSubscribeIn, me: CurrentUser, container: ContainerDep) -> Response:
    await container.push_repo.upsert(me, body.endpoint, body.keys.p256dh, body.keys.auth)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/subscribe", status_code=status.HTTP_204_NO_CONTENT)
async def unsubscribe(body: PushUnsubscribeIn, me: CurrentUser, container: ContainerDep) -> Response:
    await container.push_repo.delete(body.endpoint, code=me)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/test")
async def test_push(me: CurrentUser, container: ContainerDep) -> dict[str, object]:
    """Send a disguised test notification to the caller's own devices (diagnostics)."""
    statuses = await container.push.send_test(me, secrets.token_urlsafe(16))
    return {"enabled": container.push.enabled, "subscriptions": len(statuses), "statuses": statuses}
