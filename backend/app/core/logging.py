"""Logging setup.

Hygiene rule: logs may contain user codes and timestamps only. Never log
payloads, keys, tokens, signatures, nonces or display names.
"""

from __future__ import annotations

import logging

_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def configure_logging(level: str) -> None:
    logging.basicConfig(level=level.upper(), format=_FORMAT)
    # pywebpush/requests can log request bodies at debug level.
    for noisy in ("pywebpush", "urllib3", "requests", "pymongo"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
