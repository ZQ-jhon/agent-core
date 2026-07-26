from __future__ import annotations

import json
import logging
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_core.a2ui import validate_api_message, validate_form_document
from agent_core.a2ui_http import (
    RESOLVE_PATH,
    AuthenticatedPrincipal,
    AuthorizedResolveContext,
    FormNotFound,
    create_a2ui_app,
    create_a2ui_router,
)


ROOT = Path(__file__).resolve().parents[1]
EXAMPLES_PATH = ROOT / "docs/a2ui/v1/form-examples-v1.json"
TRUSTED_PRINCIPAL = AuthenticatedPrincipal(subject_id="subject-a", tenant_id="tenant-a")


def _approved_document() -> dict[str, Any]:
    examples = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))["examples"]
    return deepcopy(next(example for example in examples if example["formId"] == "single-field-update"))


def _resolve_payload(
    *,
    schema_version: str = "1.0.0",
    supported_versions: list[str] | None = None,
    supported_components: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "schemaVersion": schema_version,
        "requestId": "req-single-field-001",
        "formKey": "single-field-update",
        "context": {"principal": "spoofed-body-principal", "targetId": "target-001"},
        "client": {
            "supportedSchemaVersions": supported_versions or ["1.0.0"],
            "supportedComponents": supported_components
            or ["Form", "Section", "TextInput", "Button"],
        },
    }


def _response_error(response: Any) -> dict[str, Any]:
    body = response.json()
    parsed = validate_api_message(body)
    assert parsed.status == "error"
    return body


def test_resolve_returns_validated_snapshot_after_host_authorization() -> None:
    captured: dict[str, Any] = {}

    def principal_provider(request: Any) -> AuthenticatedPrincipal | None:
        return getattr(request.state, "principal", None)

    def form_authorizer(
        principal: AuthenticatedPrincipal, form_key: str, untrusted_context: Any
    ) -> AuthorizedResolveContext:
        captured["authorizer"] = (principal, form_key, untrusted_context)
        return AuthorizedResolveContext({"resourceId": "trusted-target-001"})

    def form_resolver(
        principal: AuthenticatedPrincipal, authorized_context: AuthorizedResolveContext
    ) -> dict[str, Any]:
        captured["resolver"] = (principal, authorized_context)
        return _approved_document()

    app = create_a2ui_app(
        principal_provider=principal_provider,
        form_authorizer=form_authorizer,
        form_resolver=form_resolver,
    )

    @app.middleware("http")
    async def inject_principal(request: Any, call_next: Any) -> Any:
        request.state.principal = TRUSTED_PRINCIPAL
        return await call_next(request)

    payload = _resolve_payload()
    with TestClient(app) as client:
        response = client.post(RESOLVE_PATH, json=payload)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    document = validate_form_document(response.json())
    assert document.request_id == payload["requestId"]
    assert document.form_id == "single-field-update"
    assert "text" not in response.json()
    assert "status" not in response.json()
    assert captured["authorizer"][0] == TRUSTED_PRINCIPAL
    assert captured["authorizer"][1] == payload["formKey"]
    assert captured["authorizer"][2] == payload["context"]
    assert captured["resolver"] == (
        TRUSTED_PRINCIPAL,
        AuthorizedResolveContext({"resourceId": "trusted-target-001"}),
    )


def test_resolve_openapi_declares_shared_request_and_response_models() -> None:
    app = create_a2ui_app(
        principal_provider=lambda _: TRUSTED_PRINCIPAL,
        form_authorizer=lambda *_: AuthorizedResolveContext(),
        form_resolver=lambda *_: _approved_document(),
    )

    operation = app.openapi()["paths"][RESOLVE_PATH]["post"]
    assert operation["requestBody"]["required"] is True
    assert operation["requestBody"]["content"]["application/json"]["schema"]["properties"]
    assert operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"] == (
        "#/components/schemas/A2UIFormDocumentV1"
    )
    for status_code in ("400", "401", "403", "404", "422", "500"):
        assert operation["responses"][status_code]["content"]["application/json"]["schema"]["$ref"] == (
            "#/components/schemas/FormResolveErrorV1"
        )


def test_missing_principal_returns_401_without_authorizing_or_resolving() -> None:
    calls: list[str] = []

    def principal_provider(request: Any) -> None:
        request.state.www_authenticate = 'Bearer realm="a2ui"'
        return None

    def form_authorizer(*_: Any) -> AuthorizedResolveContext:
        calls.append("authorizer")
        return AuthorizedResolveContext()

    def form_resolver(*_: Any) -> dict[str, Any]:
        calls.append("resolver")
        return _approved_document()

    app = create_a2ui_app(
        principal_provider=principal_provider,
        form_authorizer=form_authorizer,
        form_resolver=form_resolver,
    )
    with TestClient(app) as client:
        response = client.post(RESOLVE_PATH, json=_resolve_payload())

    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["www-authenticate"] == 'Bearer realm="a2ui"'
    body = _response_error(response)
    assert body["requestId"] == "req-single-field-001"
    assert body["formKey"] == "single-field-update"
    assert body["errors"] == [
        {"code": "UNAUTHENTICATED", "message": "Authentication is required.", "retryable": False}
    ]
    assert calls == []


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_principal_provider_exception_returns_safe_error_before_downstream_ports(
    is_async: bool, caplog: pytest.LogCaptureFixture
) -> None:
    call_counts = {"principal": 0, "authorizer": 0, "resolver": 0}
    unsafe_detail = "credential=top-secret"

    if is_async:

        async def principal_provider(_: Any) -> AuthenticatedPrincipal:
            call_counts["principal"] += 1
            raise RuntimeError(unsafe_detail)

    else:

        def principal_provider(_: Any) -> AuthenticatedPrincipal:
            call_counts["principal"] += 1
            raise RuntimeError(unsafe_detail)

    def form_authorizer(*_: Any) -> AuthorizedResolveContext:
        call_counts["authorizer"] += 1
        return AuthorizedResolveContext()

    def form_resolver(*_: Any) -> dict[str, Any]:
        call_counts["resolver"] += 1
        return _approved_document()

    app = create_a2ui_app(
        principal_provider=principal_provider,
        form_authorizer=form_authorizer,
        form_resolver=form_resolver,
    )
    with caplog.at_level(logging.ERROR, logger="agent_core.a2ui_http"):
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post(RESOLVE_PATH, json=_resolve_payload())

    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/json")
    body = _response_error(response)
    assert body["errors"] == [
        {
            "code": "INTERNAL_ERROR",
            "message": "An internal error prevented form resolution.",
            "retryable": True,
        }
    ]
    assert call_counts == {"principal": 1, "authorizer": 0, "resolver": 0}
    assert unsafe_detail not in caplog.text
    assert "spoofed-body-principal" not in caplog.text


def test_authorization_denial_returns_403_without_calling_resolver() -> None:
    calls: list[str] = []

    def principal_provider(_: Any) -> AuthenticatedPrincipal:
        return TRUSTED_PRINCIPAL

    def form_authorizer(*_: Any) -> None:
        calls.append("authorizer")
        return None

    def form_resolver(*_: Any) -> dict[str, Any]:
        calls.append("resolver")
        return _approved_document()

    app = create_a2ui_app(
        principal_provider=principal_provider,
        form_authorizer=form_authorizer,
        form_resolver=form_resolver,
    )
    with TestClient(app) as client:
        response = client.post(RESOLVE_PATH, json=_resolve_payload())

    assert response.status_code == 403
    assert response.headers["cache-control"] == "no-store"
    assert "www-authenticate" not in response.headers
    body = _response_error(response)
    assert body["errors"][0]["code"] == "FORBIDDEN"
    assert body["errors"][0]["retryable"] is False
    assert calls == ["authorizer"]


def test_authorized_missing_form_returns_404_only_after_authorization() -> None:
    calls: list[str] = []

    def principal_provider(_: Any) -> AuthenticatedPrincipal:
        return TRUSTED_PRINCIPAL

    def form_authorizer(*_: Any) -> AuthorizedResolveContext:
        calls.append("authorizer")
        return AuthorizedResolveContext()

    def form_resolver(*_: Any) -> dict[str, Any]:
        calls.append("resolver")
        raise FormNotFound()

    app = create_a2ui_app(
        principal_provider=principal_provider,
        form_authorizer=form_authorizer,
        form_resolver=form_resolver,
    )
    with TestClient(app) as client:
        response = client.post(RESOLVE_PATH, json=_resolve_payload())

    assert response.status_code == 404
    assert _response_error(response)["errors"][0]["code"] == "FORM_NOT_FOUND"
    assert calls == ["authorizer", "resolver"]


def test_advertised_version_mismatch_returns_422_before_resolver() -> None:
    calls: list[str] = []

    def principal_provider(_: Any) -> AuthenticatedPrincipal:
        return TRUSTED_PRINCIPAL

    def form_authorizer(*_: Any) -> AuthorizedResolveContext:
        calls.append("authorizer")
        return AuthorizedResolveContext()

    def form_resolver(*_: Any) -> dict[str, Any]:
        calls.append("resolver")
        return _approved_document()

    app = create_a2ui_app(
        principal_provider=principal_provider,
        form_authorizer=form_authorizer,
        form_resolver=form_resolver,
    )
    with TestClient(app) as client:
        response = client.post(
            RESOLVE_PATH,
            json=_resolve_payload(supported_versions=["1.0.1"]),
        )

    assert response.status_code == 422
    assert _response_error(response)["errors"][0]["code"] == "CLIENT_CAPABILITY_MISMATCH"
    assert calls == ["authorizer"]


def test_component_capability_mismatch_returns_422_after_document_validation() -> None:
    calls: list[str] = []

    def principal_provider(_: Any) -> AuthenticatedPrincipal:
        return TRUSTED_PRINCIPAL

    def form_authorizer(*_: Any) -> AuthorizedResolveContext:
        return AuthorizedResolveContext()

    def form_resolver(*_: Any) -> dict[str, Any]:
        calls.append("resolver")
        return _approved_document()

    app = create_a2ui_app(
        principal_provider=principal_provider,
        form_authorizer=form_authorizer,
        form_resolver=form_resolver,
    )
    with TestClient(app) as client:
        response = client.post(
            RESOLVE_PATH,
            json=_resolve_payload(supported_components=["Form"]),
        )

    assert response.status_code == 422
    assert _response_error(response)["errors"][0]["code"] == "CLIENT_CAPABILITY_MISMATCH"
    assert calls == ["resolver"]


def test_invalid_request_version_is_rejected_before_host_ports() -> None:
    calls: list[str] = []

    def principal_provider(_: Any) -> AuthenticatedPrincipal:
        calls.append("principal")
        return TRUSTED_PRINCIPAL

    def form_authorizer(*_: Any) -> AuthorizedResolveContext:
        calls.append("authorizer")
        return AuthorizedResolveContext()

    def form_resolver(*_: Any) -> dict[str, Any]:
        calls.append("resolver")
        return _approved_document()

    app = create_a2ui_app(
        principal_provider=principal_provider,
        form_authorizer=form_authorizer,
        form_resolver=form_resolver,
    )
    with TestClient(app) as client:
        response = client.post(RESOLVE_PATH, json=_resolve_payload(schema_version="1.0.1"))

    assert response.status_code == 400
    assert response.json()["errors"][0]["code"] == "SCHEMA_VERSION_UNSUPPORTED"
    assert calls == []


def test_invalid_resolver_profile_never_reaches_client() -> None:
    invalid_document = _approved_document()
    invalid_document["schemaVersion"] = "1.0.1"

    app = create_a2ui_app(
        principal_provider=lambda _: TRUSTED_PRINCIPAL,
        form_authorizer=lambda *_: AuthorizedResolveContext(),
        form_resolver=lambda *_: invalid_document,
    )
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post(RESOLVE_PATH, json=_resolve_payload())

    assert response.status_code == 500
    body = _response_error(response)
    assert body["errors"] == [
        {
            "code": "INTERNAL_ERROR",
            "message": "An internal error prevented form resolution.",
            "retryable": True,
        }
    ]


def test_factory_requires_every_explicit_host_port() -> None:
    with pytest.raises(TypeError, match="principal_provider"):
        create_a2ui_router(
            principal_provider=None,  # type: ignore[arg-type]
            form_authorizer=lambda *_: AuthorizedResolveContext(),
            form_resolver=lambda *_: _approved_document(),
        )
