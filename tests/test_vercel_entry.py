"""Automated tests for the Vercel serverless entry point (api/index.py).

Covers health readiness (HTTP 200 / 503), fail-closed auth, bearer token
flow, open-mode, 401, 404, and fixture-failure → 500 semantics.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

_RESOLVE_PAYLOAD: dict[str, Any] = {
    "schemaVersion": "1.0.0",
    "requestId": "t1",
    "formKey": "single-field-update",
    "client": {
        "supportedSchemaVersions": ["1.0.0"],
        "supportedComponents": ["Form", "Section", "TextInput", "Button"],
    },
}


def _make_client() -> TestClient:
    """Return a fresh TestClient with current env-vars read by api.index."""
    # Force re-import so module-level env reads reflect monkeypatched values.
    import api.index as mod
    import importlib

    importlib.reload(mod)
    return TestClient(mod.app)


# ---------------------------------------------------------------------------
# Health readiness
# ---------------------------------------------------------------------------


class TestHealth:
    def test_healthy_200_open_mode(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "open")
        monkeypatch.delenv("A2UI_API_TOKEN", raising=False)
        c = _make_client()

        r = c.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["ready"] is True
        assert "single-field-update" in body["availableForms"]
        assert "authMode" not in body

    def test_unhealthy_503_when_auth_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("A2UI_AUTH_MODE", raising=False)
        monkeypatch.delenv("A2UI_API_TOKEN", raising=False)
        c = _make_client()

        r = c.get("/api/health")
        assert r.status_code == 503
        body = r.json()
        assert body["ready"] is False
        assert body["reason"] == "auth_not_configured"

    def test_unhealthy_503_when_bearer_token_short(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "bearer")
        monkeypatch.setenv("A2UI_API_TOKEN", "short")
        c = _make_client()

        r = c.get("/api/health")
        assert r.status_code == 503
        assert r.json()["reason"] == "auth_not_configured"

    def test_healthy_200_when_bearer_valid_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "bearer")
        monkeypatch.setenv("A2UI_API_TOKEN", "a" * 32)
        c = _make_client()

        r = c.get("/api/health")
        assert r.status_code == 200
        assert r.json()["ready"] is True

    def test_unhealthy_503_when_bearer_token_empty(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "bearer")
        monkeypatch.setenv("A2UI_API_TOKEN", "")
        c = _make_client()

        r = c.get("/api/health")
        assert r.status_code == 503
        assert r.json()["reason"] == "auth_not_configured"


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


class TestAuthentication:
    def test_fail_closed_no_env_returns_401(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("A2UI_AUTH_MODE", raising=False)
        monkeypatch.delenv("A2UI_API_TOKEN", raising=False)
        c = _make_client()

        r = c.post("/api/a2ui/v1/forms:resolve", json=_RESOLVE_PAYLOAD)
        assert r.status_code == 401

    def test_open_mode_returns_200(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "open")
        monkeypatch.delenv("A2UI_API_TOKEN", raising=False)
        c = _make_client()

        r = c.post("/api/a2ui/v1/forms:resolve", json=_RESOLVE_PAYLOAD)
        assert r.status_code == 200
        assert r.json()["formId"] == "single-field-update"

    def test_bearer_no_token_returns_401(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "bearer")
        monkeypatch.setenv("A2UI_API_TOKEN", "a" * 32)
        c = _make_client()

        r = c.post("/api/a2ui/v1/forms:resolve", json=_RESOLVE_PAYLOAD)
        assert r.status_code == 401

    def test_bearer_wrong_token_returns_401(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "bearer")
        monkeypatch.setenv("A2UI_API_TOKEN", "a" * 32)
        c = _make_client()

        r = c.post(
            "/api/a2ui/v1/forms:resolve",
            json=_RESOLVE_PAYLOAD,
            headers={"Authorization": "Bearer " + "b" * 32},
        )
        assert r.status_code == 401

    def test_bearer_correct_token_returns_200(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        token = "a" * 32
        monkeypatch.setenv("A2UI_AUTH_MODE", "bearer")
        monkeypatch.setenv("A2UI_API_TOKEN", token)
        c = _make_client()

        r = c.post(
            "/api/a2ui/v1/forms:resolve",
            json=_RESOLVE_PAYLOAD,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        assert r.json()["formId"] == "single-field-update"

    def test_401_includes_cache_control_no_store(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "bearer")
        monkeypatch.setenv("A2UI_API_TOKEN", "a" * 32)
        c = _make_client()

        r = c.post("/api/a2ui/v1/forms:resolve", json=_RESOLVE_PAYLOAD)
        assert r.status_code == 401
        assert r.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# 404 / 500 semantics
# ---------------------------------------------------------------------------


class TestNotFound:
    def test_unknown_form_returns_404(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "open")
        monkeypatch.delenv("A2UI_API_TOKEN", raising=False)
        c = _make_client()

        payload = dict(_RESOLVE_PAYLOAD, formKey="no-such-form")
        r = c.post("/api/a2ui/v1/forms:resolve", json=payload)
        assert r.status_code == 404


class TestFixturesNotReady:
    """When fixtures aren't loaded, resolve returns 500 (not 404)."""

    def test_resolve_returns_500_when_fixture_file_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "open")
        monkeypatch.delenv("A2UI_API_TOKEN", raising=False)
        import api.index as mod
        import importlib

        importlib.reload(mod)
        monkeypatch.setattr(mod, "_fixtures_loaded", False)
        monkeypatch.setattr(mod, "_fixtures", {})
        c = TestClient(mod.app)

        r = c.post("/api/a2ui/v1/forms:resolve", json=_RESOLVE_PAYLOAD)
        assert r.status_code == 500

    def test_health_returns_503_when_fixture_file_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "open")
        monkeypatch.delenv("A2UI_API_TOKEN", raising=False)
        import api.index as mod
        import importlib

        importlib.reload(mod)
        monkeypatch.setattr(mod, "_fixtures_loaded", False)
        monkeypatch.setattr(mod, "_fixtures", {})
        c = TestClient(mod.app)

        r = c.get("/api/health")
        assert r.status_code == 503
        assert r.json()["reason"] == "fixtures_not_loaded"

    def test_resolve_returns_500_when_fixtures_empty(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("A2UI_AUTH_MODE", "open")
        monkeypatch.delenv("A2UI_API_TOKEN", raising=False)
        import api.index as mod
        import importlib

        importlib.reload(mod)
        monkeypatch.setattr(mod, "_fixtures_loaded", False)
        monkeypatch.setattr(mod, "_fixtures", {})
        c = TestClient(mod.app)

        r = c.post("/api/a2ui/v1/forms:resolve", json=_RESOLVE_PAYLOAD)
        assert r.status_code == 500
