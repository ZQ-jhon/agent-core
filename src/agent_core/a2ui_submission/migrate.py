"""Run A2UI schema migrations using the configured database URL."""

from __future__ import annotations

from .config import A2UISettings
from .repository import SQLiteSubmissionRepository


def main() -> None:
    settings = A2UISettings.from_env()
    SQLiteSubmissionRepository(settings.database_url).migrate()


if __name__ == "__main__":
    main()
