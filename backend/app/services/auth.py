"""Challenge-response authentication and session tokens."""

from __future__ import annotations

import logging

from app.core.clock import to_ms
from app.core.errors import unauthorized
from app.core.security import TokenSigner, auth_message, random_token, verify_ed25519_b64
from app.repositories.misc import NonceRepository
from app.repositories.users import UserRepository

log = logging.getLogger(__name__)

NONCE_TTL_SECONDS = 60


class AuthService:
    def __init__(self, users: UserRepository, nonces: NonceRepository, signer: TokenSigner) -> None:
        self._users = users
        self._nonces = nonces
        self._signer = signer

    async def challenge(self, code: str) -> tuple[str, int]:
        # Issued even for unknown codes so this endpoint cannot be used to probe the directory.
        nonce = random_token(32)
        expires = await self._nonces.create(nonce, code, NONCE_TTL_SECONDS)
        return nonce, to_ms(expires) or 0

    async def verify_signature(self, code: str, nonce: str, signature: str) -> bool:
        user = await self._users.get(code)
        if user is None:
            return False
        return verify_ed25519_b64(user["identity_key"], auth_message(nonce), signature)

    async def session_from_challenge(self, code: str, nonce: str, signature: str) -> tuple[str, int]:
        if not await self._nonces.consume(nonce, code) or not await self.verify_signature(code, nonce, signature):
            log.info("auth failed code=%s", code)
            raise unauthorized("Authentication failed")
        return self.issue(code)

    def issue(self, code: str) -> tuple[str, int]:
        return self._signer.issue(code)

    async def user_for_token(self, token: str) -> str:
        code = self._signer.verify(token)
        if code is None or await self._users.get(code) is None:
            raise unauthorized()
        return code
