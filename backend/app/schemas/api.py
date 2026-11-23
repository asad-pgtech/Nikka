"""REST request/response models (see docs/PROTOCOL.md)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, StringConstraints
from typing_extensions import Annotated

from app.schemas.common import B64Id, Code, DisplayName, Key32, Sig64, StrictModel


class ConfigOut(BaseModel):
    max_file_bytes: int
    chunk_bytes: int
    max_payload_bytes: int
    autolock_default_seconds: int
    media_ttl_days: int
    vapid_public_key: str | None


class RegisterIn(StrictModel):
    code: Code
    display_name: DisplayName
    identity_key: Key32
    agreement_key: Key32
    agreement_key_sig: Sig64
    discoverable: bool = True


class CodeOut(BaseModel):
    code: str


class ChallengeIn(StrictModel):
    code: Code


class ChallengeOut(BaseModel):
    nonce: str
    expires_at: int


class SessionIn(StrictModel):
    code: Code
    nonce: B64Id
    signature: Sig64


class SessionOut(BaseModel):
    token: str
    expires_at: int


class MeOut(BaseModel):
    code: str
    display_name: str
    discoverable: bool
    show_last_seen: bool = True


class MePatch(StrictModel):
    display_name: DisplayName | None = None
    discoverable: bool | None = None
    show_last_seen: bool | None = None


class PublicUser(BaseModel):
    code: str
    display_name: str
    identity_key: str
    agreement_key: str
    agreement_key_sig: str


class Friend(PublicUser):
    status: Literal["pending", "accepted", "declined", "blocked"]
    direction: Literal["incoming", "outgoing"]
    blocked_by_me: bool
    request_ts: int | None
    request_sig: str | None
    accept_ts: int | None
    accept_sig: str | None
    updated_at: int
    # Epoch ms the friend last went offline; null unless both sides share last seen.
    last_seen: int | None = None


class FriendsOut(BaseModel):
    friends: list[Friend]


Ts = Annotated[int, Field(ge=0, le=10**14)]


class FriendRequestIn(StrictModel):
    to: Code
    ts: Ts
    signature: Sig64


class FriendAcceptIn(StrictModel):
    ts: Ts
    signature: Sig64


class StatusOut(BaseModel):
    status: str


class MediaCreateIn(StrictModel):
    to: Code
    size: int = Field(ge=1)
    chunk_count: int = Field(ge=1)


class MediaCreateOut(BaseModel):
    blob_id: str
    chunk_bytes: int


class MediaStatusOut(BaseModel):
    blob_id: str
    size: int
    chunk_count: int
    received: list[int]
    complete: bool


class PushKeys(StrictModel):
    p256dh: Annotated[str, StringConstraints(min_length=1, max_length=256, pattern=r"^[A-Za-z0-9_\-=+/]+$")]
    auth: Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_\-=+/]+$")]


Endpoint = Annotated[str, StringConstraints(min_length=8, max_length=2048, pattern=r"^https://")]


class PushSubscribeIn(StrictModel):
    endpoint: Endpoint
    keys: PushKeys


class PushUnsubscribeIn(StrictModel):
    endpoint: Endpoint
