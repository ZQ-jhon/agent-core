"""Optional, non-streaming FastAPI adapter for A2UI Form Profile v1 resolve.

This module deliberately sits outside :mod:`agent_core`'s core import path.
Hosts opt in by installing the ``a2ui-http`` extra and by explicitly supplying
all three trusted integration ports.  It owns protocol translation only: the
host owns authentication, authorization, and form-resolution business rules.
"""

from __future__ import annotations

import inspect
import json
import logging
import re
from collections.abc import Awaitable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Protocol

try:
    from fastapi import APIRouter, FastAPI, Request
    from fastapi.responses import JSONResponse
except ModuleNotFoundError as exc:  # pragma: no cover - exercised by packaging users
    raise ImportError(
        "agent_core.a2ui_http requires the optional 'a2ui-http' extra. "
        "Install agent-core[a2ui-http]."
    ) from exc

from .a2ui import (
    A2UI_FORM_SCHEMA_VERSION,
    A2UIFormDocumentV1,
    FormResolveErrorV1,
    FormResolveRequestV1,
    GeneralErrorV1,
    ProtocolErrorCode,
    ProtocolValidationError,
    validate_form_document,
    validate_form_resolve_request,
)


RESOLVE_PATH = "/api/a2ui/v1/forms:resolve"
_STABLE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class AuthenticatedPrincipal:
    """A non-forgeable identity supplied by the host after authentication."""

    subject_id: str
    tenant_id: str

    def __post_init__(self) -> None:
        for field_name, value in (
            ("subject_id", self.subject_id),
            ("tenant_id", self.tenant_id),
        ):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{field_name} must be a non-empty string")


@dataclass(frozen=True, slots=True)
class AuthorizedResolveContext:
    """Opaque, sanitized context returned only by ``FormAuthorizer``.

    The adapter does not attach request ``context`` to this object.  Hosts may
    include only data they have independently validated for the principal,
    tenant, form key, and target business object.
    """

    values: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.values, Mapping):
            raise TypeError("values must be a mapping")
        object.__setattr__(self, "values", MappingProxyType(dict(self.values)))


class PrincipalProvider(Protocol):
    """Read a host-verified principal from ASGI state or dependency injection.

    Implementations must not parse the A2UI body, provider keys, or unverified
    caller headers as identity.  Returning ``None`` represents an unauthenticated
    request.
    """

    def __call__(
        self, request: Request
    ) -> AuthenticatedPrincipal | None | Awaitable[AuthenticatedPrincipal | None]: ...


class FormAuthorizer(Protocol):
    """Authorize a resolve request and return sanitized resolver context."""

    def __call__(
        self,
        principal: AuthenticatedPrincipal,
        form_key: str,
        untrusted_context: Mapping[str, Any] | None,
    ) -> AuthorizedResolveContext | None | Awaitable[AuthorizedResolveContext | None]: ...


class FormResolver(Protocol):
    """Resolve a validated document using only trusted identity and context."""

    def __call__(
        self,
        principal: AuthenticatedPrincipal,
        authorized_context: AuthorizedResolveContext,
    ) -> (
        A2UIFormDocumentV1
        | Mapping[str, Any]
        | Awaitable[A2UIFormDocumentV1 | Mapping[str, Any]]
    ): ...


class FormNotFound(Exception):
    """Signal a missing form only after the request has been authorized."""


def create_a2ui_router(
    *,
    principal_provider: PrincipalProvider,
    form_authorizer: FormAuthorizer,
    form_resolver: FormResolver,
) -> APIRouter:
    """Create the explicit v1 resolve router without authentication defaults.

    The route performs structural parsing before business authorization solely
    to produce a safe, correlated protocol envelope.  It never converts the
    untrusted request ``context`` into identity and never calls the resolver
    for an unauthorized request.
    """

    _require_port("principal_provider", principal_provider)
    _require_port("form_authorizer", form_authorizer)
    _require_port("form_resolver", form_resolver)

    router = APIRouter()

    @router.post(
        RESOLVE_PATH,
        response_model=None,
        responses={
            200: {
                "model": A2UIFormDocumentV1,
                "description": "Validated A2UI Form Profile v1 snapshot.",
            },
            400: {"model": FormResolveErrorV1},
            401: {"model": FormResolveErrorV1},
            403: {"model": FormResolveErrorV1},
            404: {"model": FormResolveErrorV1},
            422: {"model": FormResolveErrorV1},
            500: {"model": FormResolveErrorV1},
        },
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": FormResolveRequestV1.model_json_schema()
                    }
                },
            }
        },
    )
    async def resolve_form(request: Request) -> JSONResponse:
        parsed = await _parse_resolve_request(request)
        if isinstance(parsed, JSONResponse):
            return parsed

        try:
            principal = await _await_port(principal_provider(request))
        except Exception:
            logger.error("A2UI principal provider failed during form resolution")
            return _internal_error(parsed)
        if not isinstance(principal, AuthenticatedPrincipal):
            headers = {"Cache-Control": "no-store"}
            challenge = _trusted_authentication_challenge(request)
            if challenge is not None:
                headers["WWW-Authenticate"] = challenge
            return _resolve_error_response(
                status_code=401,
                request_id=parsed.request_id,
                form_key=parsed.form_key,
                code="UNAUTHENTICATED",
                message="Authentication is required.",
                headers=headers,
            )

        untrusted_context = _read_only_context(parsed.context)
        try:
            authorized_context = await _await_port(
                form_authorizer(principal, parsed.form_key, untrusted_context)
            )
        except Exception:
            return _internal_error(parsed)

        if authorized_context is None:
            return _resolve_error_response(
                status_code=403,
                request_id=parsed.request_id,
                form_key=parsed.form_key,
                code="FORBIDDEN",
                message="The authenticated principal is not authorized for this form.",
                headers={"Cache-Control": "no-store"},
            )
        if not isinstance(authorized_context, AuthorizedResolveContext):
            return _internal_error(parsed)

        if A2UI_FORM_SCHEMA_VERSION not in parsed.client.supported_schema_versions:
            return _capability_mismatch(parsed)

        try:
            resolved = await _await_port(form_resolver(principal, authorized_context))
            document = _validated_document_for_request(resolved, parsed.request_id)
        except FormNotFound:
            return _resolve_error_response(
                status_code=404,
                request_id=parsed.request_id,
                form_key=parsed.form_key,
                code="FORM_NOT_FOUND",
                message="The requested form was not found.",
            )
        except (ProtocolValidationError, TypeError, ValueError):
            return _internal_error(parsed)
        except Exception:
            return _internal_error(parsed)

        if not _document_components_are_supported(document, parsed):
            return _capability_mismatch(parsed)

        return JSONResponse(
            status_code=200,
            content=document.model_dump(by_alias=True, exclude_none=True),
        )

    return router


def create_a2ui_app(
    *,
    principal_provider: PrincipalProvider,
    form_authorizer: FormAuthorizer,
    form_resolver: FormResolver,
) -> FastAPI:
    """Create a small standalone ASGI app for hosts and adapter tests."""

    app = FastAPI(title="A2UI Form Profile v1 Resolve", version=A2UI_FORM_SCHEMA_VERSION)
    app.include_router(
        create_a2ui_router(
            principal_provider=principal_provider,
            form_authorizer=form_authorizer,
            form_resolver=form_resolver,
        )
    )
    return app


async def _parse_resolve_request(
    request: Request,
) -> FormResolveRequestV1 | JSONResponse:
    content_type = request.headers.get("content-type", "")
    if "application/json" not in content_type.lower():
        return _invalid_request_response(None, ProtocolErrorCode.REQUEST_INVALID)

    payload: Any = None
    try:
        payload = await request.json()
        return validate_form_resolve_request(payload)
    except (json.JSONDecodeError, UnicodeDecodeError, ProtocolValidationError) as exc:
        code = exc.code if isinstance(exc, ProtocolValidationError) else ProtocolErrorCode.REQUEST_INVALID
        return _invalid_request_response(payload, code)
    except (TypeError, ValueError):
        return _invalid_request_response(payload, ProtocolErrorCode.REQUEST_INVALID)


def _invalid_request_response(payload: Any, code: ProtocolErrorCode) -> JSONResponse:
    request_id, form_key = _safe_request_identifiers(payload)
    return _resolve_error_response(
        status_code=400,
        request_id=request_id,
        form_key=form_key,
        code=code.value,
        message="The A2UI resolve request is invalid.",
    )


def _validated_document_for_request(
    resolved: A2UIFormDocumentV1 | Mapping[str, Any], request_id: str
) -> A2UIFormDocumentV1:
    payload: Any
    if isinstance(resolved, A2UIFormDocumentV1):
        payload = resolved.model_dump(by_alias=True, exclude_none=True)
    else:
        payload = resolved
    if not isinstance(payload, Mapping):
        raise TypeError("FormResolver must return an A2UI document mapping")
    document_payload = dict(payload)
    # Correlation is adapter-owned; the resolver never needs raw request data.
    document_payload["requestId"] = request_id
    return validate_form_document(document_payload)


def _document_components_are_supported(
    document: A2UIFormDocumentV1, request: FormResolveRequestV1
) -> bool:
    supported_components = set(request.client.supported_components)
    return all(component_type in supported_components for component_type in _component_types(document.root))


def _component_types(node: Any) -> list[str]:
    types = [node.type]
    for child in node.children:
        types.extend(_component_types(child))
    return types


def _capability_mismatch(request: FormResolveRequestV1) -> JSONResponse:
    return _resolve_error_response(
        status_code=422,
        request_id=request.request_id,
        form_key=request.form_key,
        code="CLIENT_CAPABILITY_MISMATCH",
        message="The client cannot render this form.",
    )


def _internal_error(request: FormResolveRequestV1) -> JSONResponse:
    return _resolve_error_response(
        status_code=500,
        request_id=request.request_id,
        form_key=request.form_key,
        code="INTERNAL_ERROR",
        message="An internal error prevented form resolution.",
        retryable=True,
    )


def _resolve_error_response(
    *,
    status_code: int,
    request_id: str,
    form_key: str,
    code: str,
    message: str,
    retryable: bool = False,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    envelope = FormResolveErrorV1(
        schemaVersion=A2UI_FORM_SCHEMA_VERSION,
        requestId=request_id,
        formKey=form_key,
        status="error",
        errors=[GeneralErrorV1(code=code, message=message, retryable=retryable)],
    )
    return JSONResponse(
        status_code=status_code,
        content=envelope.model_dump(by_alias=True, exclude_none=True),
        headers=dict(headers or {}),
    )


def _safe_request_identifiers(payload: Any) -> tuple[str, str]:
    if not isinstance(payload, Mapping):
        return "unknown", "unknown"
    return _safe_stable_id(payload.get("requestId")), _safe_stable_id(payload.get("formKey"))


def _safe_stable_id(value: Any) -> str:
    if isinstance(value, str) and _STABLE_ID_PATTERN.fullmatch(value):
        return value
    return "unknown"


def _read_only_context(context: dict[str, Any] | None) -> Mapping[str, Any] | None:
    if context is None:
        return None
    return MappingProxyType(dict(context))


def _trusted_authentication_challenge(request: Request) -> str | None:
    """Read only a host-set challenge; never derive one from request headers."""

    challenge = getattr(request.state, "www_authenticate", None)
    if (
        isinstance(challenge, str)
        and challenge
        and "\r" not in challenge
        and "\n" not in challenge
    ):
        return challenge
    return None


async def _await_port(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _require_port(name: str, value: object) -> None:
    if not callable(value):
        raise TypeError(f"{name} must be explicitly supplied as a callable port")


__all__ = [
    "AuthenticatedPrincipal",
    "AuthorizedResolveContext",
    "FormAuthorizer",
    "FormNotFound",
    "FormResolver",
    "PrincipalProvider",
    "RESOLVE_PATH",
    "create_a2ui_app",
    "create_a2ui_router",
]
