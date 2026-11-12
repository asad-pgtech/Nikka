"""Domain errors mapped to the protocol's error envelope."""

from __future__ import annotations


class AppError(Exception):
    """Error rendered as `{"detail": {"code", "message"}}` with an HTTP status."""

    def __init__(self, status: int, code: str, message: str = "") -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message or code.replace("_", " ")


def not_found(message: str = "Not found") -> AppError:
    return AppError(404, "not_found", message)


def bad_request(code: str = "invalid", message: str = "Invalid request") -> AppError:
    return AppError(400, code, message)


def unauthorized(message: str = "Unauthorized") -> AppError:
    return AppError(401, "unauthorized", message)


def conflict(code: str, message: str = "") -> AppError:
    return AppError(409, code, message)


def too_many(code: str = "rate_limited", message: str = "Too many requests") -> AppError:
    return AppError(429, code, message)
