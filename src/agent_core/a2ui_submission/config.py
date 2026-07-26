"""Configuration for the isolated A2UI persistence adapter."""

from __future__ import annotations

import os
from dataclasses import dataclass


DEFAULT_DATABASE_URL = "sqlite:///./.a2ui/a2ui-submissions.db"


@dataclass(frozen=True)
class A2UISettings:
    database_url: str = DEFAULT_DATABASE_URL

    @classmethod
    def from_env(cls) -> "A2UISettings":
        return cls(database_url=os.getenv("A2UI_DATABASE_URL", DEFAULT_DATABASE_URL))
