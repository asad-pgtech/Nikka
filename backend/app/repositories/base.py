from __future__ import annotations

from pymongo.asynchronous.collection import AsyncCollection
from pymongo.asynchronous.database import AsyncDatabase


class Repository:
    collection_name: str

    def __init__(self, db: AsyncDatabase) -> None:
        self.col: AsyncCollection = db[self.collection_name]
