"""Versioned SQLite schema migrations for A2UI submissions.

Migrations are intentionally dependency-free.  The repository applies each
version only once under an immediate transaction and records it in
``schema_migrations``.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Migration:
    version: str
    statements: tuple[str, ...]


MIGRATIONS: tuple[Migration, ...] = (
    Migration(
        version="0001_a2ui_form_submissions",
        statements=(
            """
            CREATE TABLE IF NOT EXISTS a2ui_submissions (
                submission_id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                subject_id TEXT NOT NULL,
                form_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision >= 1),
                action_id TEXT NOT NULL,
                source_component_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_fingerprint TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('processing', 'completed')),
                data_json TEXT NOT NULL,
                file_refs_json TEXT NOT NULL,
                response_status INTEGER,
                response_json TEXT,
                request_id TEXT NOT NULL,
                audit_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (
                    tenant_id,
                    subject_id,
                    form_id,
                    revision,
                    action_id,
                    idempotency_key
                )
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_a2ui_submissions_owner_lookup
            ON a2ui_submissions (tenant_id, subject_id, submission_id)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_a2ui_submissions_audit
            ON a2ui_submissions (audit_id)
            """,
        ),
    ),
)
