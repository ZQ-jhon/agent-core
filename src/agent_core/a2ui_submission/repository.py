"""SQLite persistence and repeatable migrations for A2UI submissions."""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .migrations import MIGRATIONS


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sqlite_path_from_url(database_url: str) -> str:
    """Parse the intentionally narrow local-development database URL format."""

    if not database_url.startswith("sqlite:///"):
        raise ValueError(
            "A2UI_DATABASE_URL must use sqlite:/// for this adapter; "
            "configure a PostgreSQL repository implementation before production."
        )
    path = database_url.removeprefix("sqlite:///")
    if not path:
        raise ValueError("A2UI_DATABASE_URL must include a SQLite path")
    if path != ":memory:":
        Path(path).expanduser().parent.mkdir(parents=True, exist_ok=True)
    return path


@dataclass(frozen=True)
class IdempotencyScope:
    tenant_id: str
    subject_id: str
    form_id: str
    revision: int
    action_id: str
    idempotency_key: str


@dataclass(frozen=True)
class StoredSubmission:
    submission_id: str
    tenant_id: str
    subject_id: str
    form_id: str
    revision: int
    action_id: str
    source_component_id: str
    idempotency_key: str
    request_fingerprint: str
    state: str
    data: dict[str, Any]
    file_references: list[dict[str, str]]
    response_status: int | None
    response_body: dict[str, Any] | None
    request_id: str
    audit_id: str
    created_at: str
    updated_at: str


class SQLiteSubmissionRepository:
    """A small repository with an explicit transaction boundary.

    A fresh connection is used for each operation.  ``BEGIN IMMEDIATE`` makes
    concurrent first submissions serialize before validation and insertion, so
    a same-key retry can only observe the completed durable response.
    """

    def __init__(self, database_url: str) -> None:
        self.database_path = sqlite_path_from_url(database_url)
        self._uses_uri = False
        self._memory_anchor: sqlite3.Connection | None = None
        if self.database_path == ":memory:":
            # SQLite creates a separate private database for every :memory:
            # connection. Use a named shared cache and retain one anchor so the
            # migration and request connections operate on the same test DB.
            self.database_path = f"file:a2ui-{uuid.uuid4().hex}?mode=memory&cache=shared"
            self._uses_uri = True
            self._memory_anchor = self._connect()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.database_path,
            timeout=10,
            isolation_level=None,
            check_same_thread=False,
            uri=self._uses_uri,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    def close(self) -> None:
        """Release the optional shared in-memory anchor on application shutdown."""

        if self._memory_anchor is not None:
            self._memory_anchor.close()
            self._memory_anchor = None

    def migrate(self) -> None:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version TEXT PRIMARY KEY,
                    applied_at TEXT NOT NULL
                )
                """
            )
            applied = {
                row["version"]
                for row in connection.execute("SELECT version FROM schema_migrations")
            }
            for migration in MIGRATIONS:
                if migration.version in applied:
                    continue
                for statement in migration.statements:
                    connection.execute(statement)
                connection.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (migration.version, utc_now()),
                )
            connection.execute("COMMIT")
        except Exception:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    @contextmanager
    def write_transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.execute("COMMIT")
        except Exception:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    @staticmethod
    def find_by_idempotency(
        connection: sqlite3.Connection,
        scope: IdempotencyScope,
    ) -> StoredSubmission | None:
        row = connection.execute(
            """
            SELECT * FROM a2ui_submissions
            WHERE tenant_id = ?
              AND subject_id = ?
              AND form_id = ?
              AND revision = ?
              AND action_id = ?
              AND idempotency_key = ?
            """,
            (
                scope.tenant_id,
                scope.subject_id,
                scope.form_id,
                scope.revision,
                scope.action_id,
                scope.idempotency_key,
            ),
        ).fetchone()
        return _from_row(row) if row else None

    @staticmethod
    def insert(
        connection: sqlite3.Connection,
        submission: StoredSubmission,
    ) -> None:
        connection.execute(
            """
            INSERT INTO a2ui_submissions (
                submission_id, tenant_id, subject_id, form_id, revision,
                action_id, source_component_id, idempotency_key,
                request_fingerprint, state, data_json, file_refs_json,
                response_status, response_json, request_id, audit_id,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                submission.submission_id,
                submission.tenant_id,
                submission.subject_id,
                submission.form_id,
                submission.revision,
                submission.action_id,
                submission.source_component_id,
                submission.idempotency_key,
                submission.request_fingerprint,
                submission.state,
                _json_dump(submission.data),
                _json_dump(submission.file_references),
                submission.response_status,
                _json_dump(submission.response_body) if submission.response_body else None,
                submission.request_id,
                submission.audit_id,
                submission.created_at,
                submission.updated_at,
            ),
        )

    def get_for_owner(
        self,
        *,
        submission_id: str,
        tenant_id: str,
        subject_id: str,
    ) -> StoredSubmission | None:
        connection = self._connect()
        try:
            row = connection.execute(
                """
                SELECT * FROM a2ui_submissions
                WHERE submission_id = ? AND tenant_id = ? AND subject_id = ?
                """,
                (submission_id, tenant_id, subject_id),
            ).fetchone()
            return _from_row(row) if row else None
        finally:
            connection.close()

    def count_submissions(self) -> int:
        connection = self._connect()
        try:
            return int(
                connection.execute("SELECT COUNT(*) AS count FROM a2ui_submissions")
                .fetchone()["count"]
            )
        finally:
            connection.close()

    def applied_migrations(self) -> list[str]:
        connection = self._connect()
        try:
            return [
                row["version"]
                for row in connection.execute(
                    "SELECT version FROM schema_migrations ORDER BY version"
                )
            ]
        finally:
            connection.close()


def _json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _from_row(row: sqlite3.Row) -> StoredSubmission:
    response_json = row["response_json"]
    return StoredSubmission(
        submission_id=row["submission_id"],
        tenant_id=row["tenant_id"],
        subject_id=row["subject_id"],
        form_id=row["form_id"],
        revision=row["revision"],
        action_id=row["action_id"],
        source_component_id=row["source_component_id"],
        idempotency_key=row["idempotency_key"],
        request_fingerprint=row["request_fingerprint"],
        state=row["state"],
        data=json.loads(row["data_json"]),
        file_references=json.loads(row["file_refs_json"]),
        response_status=row["response_status"],
        response_body=json.loads(response_json) if response_json else None,
        request_id=row["request_id"],
        audit_id=row["audit_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
