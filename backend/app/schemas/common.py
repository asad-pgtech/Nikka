"""Reusable validated field types."""

from __future__ import annotations

from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints

from app.core.security import b64d, is_valid_code, normalize_code


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _code(value: str) -> str:
    code = normalize_code(value)
    if not is_valid_code(code):
        raise ValueError("invalid code")
    return code


def _b64_len(n: int):
    def check(value: str) -> str:
        try:
            raw = b64d(value)
        except ValueError as exc:
            raise ValueError("invalid base64url") from exc
        if len(raw) != n:
            raise ValueError(f"expected {n} bytes")
        return value

    return check


def _display_name(value: str) -> str:
    value = value.strip()
    if not 1 <= len(value) <= 40:
        raise ValueError("display_name must be 1-40 characters")
    if any(ord(c) < 32 for c in value):
        raise ValueError("display_name contains control characters")
    return value


Code = Annotated[str, StringConstraints(max_length=32), AfterValidator(_code)]
Key32 = Annotated[str, StringConstraints(max_length=64), AfterValidator(_b64_len(32))]
Sig64 = Annotated[str, StringConstraints(max_length=100), AfterValidator(_b64_len(64))]
DisplayName = Annotated[str, StringConstraints(max_length=200), AfterValidator(_display_name)]
B64Id = Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
