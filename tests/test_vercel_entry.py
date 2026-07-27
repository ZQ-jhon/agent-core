"""Automated tests for the Vercel serverless entry point (api/index.py).

Covers health readiness (HTTP 200 / 503), fail-closed auth, bearer token
flow, open-mode, 401, and 404 semantics.  These are contract-level tests
that the Vercel entry point must satisfy before a Preview deployment.
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path
from typing import Any

import pytest

# Ensure repo root is importable (api/ is a sub-package)
_REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_RESOLVE_PAYLOAD: dict[str, Any] = {
    "schemaVersion": "1.0.0",
    "requestId": "t1",
    "formKey": "single-field-update",
    "client": {
        "supportedSchemaVersions": ["1.0.0"],
        "supportedComponents": ["Form", "Section", "TextInput", "Button"],
    },
}


def _clear_env() -> None:
    for k in ("A2UI_AUTH_MODE", "A2UI_API_TOKEN"):
        os.environ.pop(k, None)


def _reload_entry():
    """Re-import api.index with current env vars to pick up config changes."""
    _clear_pycache()
    import api.index as mod

    importlib.reload(mod)
    return mod


def _clear_pycache() -> None:
    # Prevent stale .pyc from masking re-imports under reload()
    cache = _REPO_ROOT / "api" / "__pycache__"
    if cache.is_dir():
        for f in cache.iterdir():
            if f.name.startswith("index."):
                f.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Health readiness
# ---------------------------------------------------------------------------


class TestHealth:
    def test_healthy_when_fixtures_loaded_and_auth_configured(self) -> None:
        """open mode + valid fixtures → 200 ready=true + availableForms."""
        _clear_env()
        os.environ["A2UI_AUTH_MODE"] = "open"
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["ready"] is True
        assert "availableForms" in body
        assert "single-field-update" in body["availableForms"]
        assert "authMode" not in body

    def test_unhealthy_503_when_auth_mode_unset(self) -> None:
        """No A2UI_AUTH_MODE → 503 ready=false reason=auth_not_configured."""
        _clear_env()
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.get("/api/health")
        assert r.status_code == 503
        body = r.json()
        assert body["ready"] is False
        assert body["reason"] == "auth_not_configured"

    def test_unhealthy_503_when_bearer_token_too_short(self) -> None:
        """Bearer with token < 32 chars → 503 ready=false."""
        _clear_env()
        os.environ["A2UI_AUTH_MODE"] = "bearer"
        os.environ["A2UI_API_TOKEN"] = "short"
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.get("/api/health")
        assert r.status_code == 503
        body = r.json()
        assert body["ready"] is False
        assert body["reason"] == "auth_not_configured"

    def test_healthy_200_when_bearer_with_valid_token(self) -> None:
        """Bearer with ≥32-char token → 200 ready=true."""
        _clear_env()
        os.environ["A2UI_AUTH_MODE"] = "bearer"
        os.environ["A2UI_API_TOKEN"] = "a" * 32
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.get("/api/health")
        assert r.status_code == 200
        assert r.json()["ready"] is True

    def test_unhealthy_503_when_bearer_token_empty(self) -> None:
        """Bearer with empty A2UI_API_TOKEN → 503."""
        _clear_env()
        os.environ["A2UI_AUTH_MODE"] = "bearer"
        os.environ["A2UI_API_TOKEN"] = ""
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.get("/api/health")
        assert r.status_code == 503
        body = r.json()
        assert body["ready"] is False
        assert body["reason"] == "auth_not_configured"


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


class TestAuthentication:
    def test_fail_closed_no_env_returns_401(self) -> None:
        """Unset A2UI_AUTH_MODE → fail-closed, resolve returns 401."""
        _clear_env()
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.post("/api/a2ui/v1/forms:resolve", json=_RESOLVE_PAYLOAD)
        assert r.status_code == 401

    def test_open_mode_returns_200_without_token(self) -> None:
        """Explicit open mode → resolve succeeds without token."""
        _clear_env()
        os.environ["A2UI_AUTH_MODE"] = "open"
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.post("/api/a2ui/v1/forms:resolve", json=_RESOLVE_PAYLOAD)
        assert r.status_code == 200
        assert r.json()["formId"] == "single-field-update"

    def test_bearer_no_token_returns_401(self) -> None:
        _clear_env()
        os.environ["A2UI_AUTH_MODE"] = "bearer"
        os.environ["A2UI_API_TOKEN"] = "a" * 32
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.post("/api/a2ui/v1/forms:resolve", json=_RESOLVE_PAYLOAD)
        assert r.status_code == 401

    def test_bearer_wrong_token_returns_401(self) -> None:
        _clear_env()
        os.environ["A2UI_AUTH_MODE"] = "bearer"
        os.environ["A2UI_API_TOKEN"] = "a" * 32
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.post(
            "/api/a2ui/v1/forms:resolve",
            json=_RESOLVE_PAYLOAD,
            headers={"Authorization": "Bearer " + "b" * 32},
        )
        assert r.status_code == 401

    def test_bearer_correct_token_returns_200(self) -> None:
        _clear_env()
        token = "a" * 32
        os.environ["A2UI_AUTH_MODE"] = "bearer"
        os.environ["A2UI_API_TOKEN"] = token
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.post(
            "/api/a2ui/v1/forms:resolve",
            json=_RESOLVE_PAYLOAD,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        assert r.json()["formId"] == "single-field-update"

    def test_401_includes_cache_control_no_store(self) -> None:
        _clear_env()
        os.environ["A2UI_AUTH_MODE"] = "bearer"
        os.environ["A2UI_API_TOKEN"] = "a" * 32
        mod = _reload_entry()
        c = TestClient(mod.app)

        r = c.post("/api/a2ui/v1/forms:resolve", json=_RESOLVE_PAYLOAD)
        assert r.status_code == 401
        assert r.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# 404 semantics
# ---------------------------------------------------------------------------


class TestNotFound:
    def test_unknown_form_returns_404(self) -> None:
        """Unknown formKey → resolver → 404, not 403 from authorizer."""
        _clear_env()
        os.environ["A2UI_AUTH_MODE"] = "open"
        mod = _reload_entry()
        c = TestClient(mod.app)

        payload = dict(_RESOLVE_PAYLOAD, formKey="no-such-form")
        r = c.post("/api/a2ui/v1/forms:resolve", json=payload)
        assert r.status_code == 404
