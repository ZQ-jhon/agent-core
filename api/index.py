"""
Vercel serverless entry point for agent-core A2UI Backend.

Deployed alongside the Vite frontend on Vercel under the same domain.
Uses Vercel's native ``api/index.py`` catch-all pattern — no rewrite needed.

Same-domain deployment means no CORS middleware is required; the browser
sees a single origin for both static assets and /api/* calls.

Authentication
--------------
Fail-closed by default.  Controlled by ``A2UI_AUTH_MODE``:

  - **unset / unrecognised**: all requests 401 (safe default — no accidental open)
  - ``"open"``: explicit dev / public-demo only.  Every request maps to
    ``demo-user@demo``.  Never use in production.
  - ``"bearer"``: clients MUST send ``Authorization: Bearer <token>``
    matching ``A2UI_API_TOKEN``.  Constant-time comparison via
    ``secrets.compare_digest``; token is never logged.

For browser-based (static Vite) callers, the ``bearer`` shared-token model
is NOT suitable — do not inject ``A2UI_API_TOKEN`` into ``VITE_*``.  Use a
BFF proxy, HttpOnly session cookie, or explicitly choose ``open`` for a
public unauthenticated demo after confirming the scope.

Scope
-----
resolve-only (no database).  Submissions need persistent storage (Turso /
Neon) and a separate follow-up issue.

Fixture stability
-----------------
Resolved by ``__file__`` — never depends on CWD.  If the bundled fixture
file is missing, unreadable, or contains zero examples, health returns 503
and all resolve requests return 500 (fail-fast — no silent broken service).
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import sys
from pathlib import Path
from typing import Any

# Ensure src/ is importable (Vercel runs from project root, src/ is a sibling)
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_PROJECT_ROOT / "src"))

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from agent_core.a2ui_http import (
    AuthenticatedPrincipal,
    AuthorizedResolveContext,
    FormNotFound,
    create_a2ui_router,
)

logger = logging.getLogger("agent_core.vercel")

# ---------------------------------------------------------------------------
# Auth configuration — fail-closed by default
# ---------------------------------------------------------------------------

_AUTH_MODE_RAW = os.getenv("A2UI_AUTH_MODE", "").strip().lower()
_API_TOKEN = os.getenv("A2UI_API_TOKEN", "").strip()

_auth_ready = False

if _AUTH_MODE_RAW == "open":
    AUTH_MODE = "open"
    _auth_ready = True
elif _AUTH_MODE_RAW == "bearer":
    AUTH_MODE = "bearer"
    if _API_TOKEN and len(_API_TOKEN) >= 32:
        _auth_ready = True
    else:
        logger.critical(
            "A2UI_AUTH_MODE=bearer but A2UI_API_TOKEN is missing or too short "
            "(< 32 chars) — authentication is not operational"
        )
else:
    logger.critical(
        "A2UI_AUTH_MODE=%r is not 'open' or 'bearer' — "
        "authentication is not operational",
        _AUTH_MODE_RAW or "<unset>",
    )
    AUTH_MODE = "bearer"
    _API_TOKEN = ""

# ---------------------------------------------------------------------------
# Form fixtures — fail-fast on load failure (also reject empty set)
# ---------------------------------------------------------------------------

FIXTURES_PATH = _PROJECT_ROOT / "docs" / "a2ui" / "v1" / "form-examples-v1.json"

_fixtures: dict[str, dict[str, Any]] = {}
_fixtures_loaded = False

if FIXTURES_PATH.is_file():
    try:
        with open(FIXTURES_PATH, encoding="utf-8") as fh:
            for example in json.load(fh).get("examples", []):
                _fixtures[example["formId"]] = example
        if _fixtures:
            _fixtures_loaded = True
            logger.info("Loaded %d A2UI form fixtures", len(_fixtures))
        else:
            logger.critical("A2UI fixtures file contains zero examples")
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        logger.critical(
            "Failed to parse A2UI fixtures from %s: %s", FIXTURES_PATH, exc
        )
else:
    logger.critical("A2UI fixtures not found at %s", FIXTURES_PATH)


class FixturesNotReady(Exception):
    """Raised when fixtures aren't loaded — adapter will return 500."""


# ---------------------------------------------------------------------------
# Trusted ports
# ---------------------------------------------------------------------------


def _extract_bearer_token(request: Request) -> str | None:
    """Extract a Bearer token without logging the raw header value."""
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        return None
    token = auth[7:].strip()
    return token or None


def _principal_provider(request: Request) -> AuthenticatedPrincipal | None:
    """Authenticate via Bearer token (prod) or accept all (explicit dev).

    Returns ``None`` → the shared adapter produces the 401 envelope.
    """
    if AUTH_MODE == "open":
        return AuthenticatedPrincipal(subject_id="demo-user", tenant_id="demo")

    token = _extract_bearer_token(request)
    if not token:
        return None

    if not secrets.compare_digest(token, _API_TOKEN):
        logger.warning("A2UI resolve: invalid Bearer token")
        return None

    return AuthenticatedPrincipal(subject_id="demo-user", tenant_id="demo")


def _form_authorizer(
    principal: AuthenticatedPrincipal,
    form_key: str,
    _untrusted_context: Any,
) -> AuthorizedResolveContext | None:
    """Authorize all forms for every authenticated principal.

    Returns ``None`` only for the ``FORBIDDEN`` case: an authenticated
    principal attempting to access a known, restricted form.  In this
    demo deployment all fixtures are public, so no form is restricted.
    """
    return AuthorizedResolveContext({"formKey": form_key})


def _form_resolver(
    principal: AuthenticatedPrincipal,
    authorized_context: AuthorizedResolveContext,
) -> dict[str, Any]:
    """Resolve from approved A2UI fixtures.

    Raises ``FixturesNotReady`` → 500 when fixtures aren't loaded
    (infrastructure failure, must not masquerade as a missing form).

    Raises ``FormNotFound`` → 404 when the specific form key is absent.
    """
    if not _fixtures_loaded:
        raise FixturesNotReady("A2UI fixtures are not available")

    form_key = authorized_context.values.get("formKey", "")
    document = _fixtures.get(form_key)
    if document is None:
        raise FormNotFound(f"Form not found: {form_key}")
    return document


# ---------------------------------------------------------------------------
# App assembly
# ---------------------------------------------------------------------------

_resolve_router = create_a2ui_router(
    principal_provider=_principal_provider,
    form_authorizer=_form_authorizer,
    form_resolver=_form_resolver,
)

app = FastAPI(
    title="agent-core A2UI Backend",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.include_router(_resolve_router)

# Same-domain deployment: no CORS middleware needed.
# The browser sees a single origin for static assets and /api/*.

# ---------------------------------------------------------------------------
# Health check — HTTP 503 when service is not operational
# ---------------------------------------------------------------------------

_HEALTHY_STATUS = 200
_UNHEALTHY_STATUS = 503


@app.get("/api/health")
async def health() -> JSONResponse:
    if not _fixtures_loaded:
        return JSONResponse(
            status_code=_UNHEALTHY_STATUS,
            content={
                "status": "error",
                "ready": False,
                "service": "agent-core-a2ui",
                "version": "0.1.0",
                "reason": "fixtures_not_loaded",
            },
        )
    if not _auth_ready:
        return JSONResponse(
            status_code=_UNHEALTHY_STATUS,
            content={
                "status": "error",
                "ready": False,
                "service": "agent-core-a2ui",
                "version": "0.1.0",
                "reason": "auth_not_configured",
            },
        )
    return JSONResponse(
        status_code=_HEALTHY_STATUS,
        content={
            "status": "ok",
            "ready": True,
            "service": "agent-core-a2ui",
            "version": "0.1.0",
            "availableForms": sorted(_fixtures.keys()),
        },
    )
