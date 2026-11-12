"""Application settings, loaded from environment variables."""

from __future__ import annotations

import math
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    # Storage
    mongo_url: str = "mongodb://localhost:27017"
    mongo_db: str = "lanchat"
    media_dir: Path = Path("/data/media")

    # Limits
    max_file_mb: int = Field(default=100, ge=1)
    chunk_kb: int = Field(default=512, ge=16, le=8192)
    max_payload_kb: int = Field(default=64, ge=1, le=1024)

    # Retention
    media_ttl_days: int = Field(default=30, ge=1)
    queue_ttl_days: int = Field(default=30, ge=1)

    # Rate limits
    request_cooldown_hours: int = Field(default=24, ge=0)
    request_daily_cap: int = Field(default=20, ge=1)
    lookup_per_minute: int = Field(default=30, ge=1)

    # Client defaults
    autolock_default_seconds: int = Field(default=120, ge=10)

    # Sessions
    session_ttl_minutes: int = Field(default=60, ge=1)
    session_secret: str | None = None  # random per process when unset

    # Web Push (VAPID)
    vapid_public_key: str | None = None
    vapid_private_key: str | None = None
    vapid_subject: str = "mailto:admin@localhost"

    # Ops
    log_level: str = "INFO"
    job_interval_seconds: int = Field(default=300, ge=1)

    @field_validator("vapid_public_key", "vapid_private_key", "session_secret", mode="before")
    @classmethod
    def _blank_to_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("session_secret", mode="after")
    @classmethod
    def _secret_default(cls, value: str | None) -> str:
        # Unset: tokens are invalidated on restart; clients re-authenticate transparently.
        return value or secrets.token_urlsafe(32)

    # Derived values -------------------------------------------------------
    @property
    def max_file_bytes(self) -> int:
        return self.max_file_mb * 1024 * 1024

    @property
    def chunk_bytes(self) -> int:
        return self.chunk_kb * 1024

    @property
    def max_chunk_body_bytes(self) -> int:
        """Ciphertext chunk = plaintext chunk + 16-byte GCM tag."""
        return self.chunk_bytes + 16

    @property
    def max_chunks(self) -> int:
        return math.ceil(self.max_file_bytes / self.chunk_bytes)

    @property
    def max_payload_bytes(self) -> int:
        return self.max_payload_kb * 1024

    @property
    def max_ws_frame_bytes(self) -> int:
        # base64 inflates the payload by 4/3, plus room for the JSON wrapper.
        return math.ceil(self.max_payload_bytes * 4 / 3) + 4096

    @property
    def push_enabled(self) -> bool:
        return bool(self.vapid_public_key and self.vapid_private_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
