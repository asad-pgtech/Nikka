from __future__ import annotations

from fastapi import APIRouter, Response, status

from app.api.deps import ContainerDep
from app.schemas.api import ChallengeIn, ChallengeOut, CodeOut, RegisterIn, SessionIn, SessionOut

router = APIRouter(tags=["auth"])


@router.post("/register", response_model=CodeOut, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterIn, container: ContainerDep, response: Response) -> CodeOut:
    created = await container.users.register(body)
    if not created:
        response.status_code = status.HTTP_200_OK
    return CodeOut(code=body.code)


@router.post("/auth/challenge", response_model=ChallengeOut)
async def challenge(body: ChallengeIn, container: ContainerDep) -> ChallengeOut:
    nonce, expires_at = await container.auth.challenge(body.code)
    return ChallengeOut(nonce=nonce, expires_at=expires_at)


@router.post("/auth/session", response_model=SessionOut)
async def session(body: SessionIn, container: ContainerDep) -> SessionOut:
    token, expires_at = await container.auth.session_from_challenge(body.code, body.nonce, body.signature)
    return SessionOut(token=token, expires_at=expires_at)
