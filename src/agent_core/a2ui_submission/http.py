"""Optional FastAPI router for persisted A2UI Form Profile v1 submissions.

This adapter deliberately owns only submission transport translation.  It uses
the shared Profile models from :mod:`agent_core.a2ui` and the trusted host ports
from :mod:`agent_core.a2ui_http`; importing the persistence core never imports
FastAPI.
"""

from __future__ import annotations

import inspect
import json
import logging
import re
from collections.abc import Mapping
from typing import Any

try:
    from fastapi import APIRouter, Request
    from fastapi.responses import JSONResponse
except ModuleNotFoundError as exc:  # pragma: no cover - exercised by package users
    raise ImportError(
        "agent_core.a2ui_submission.http requires the optional 'a2ui-http' extra. "
        "Install agent-core[a2ui-http]."
    ) from exc

from agent_core.a2ui import (
    FormSubmitErrorV1,
    FormSubmitRequestV1,
    FormSubmitSuccessV1,
    FormSubmitValidationErrorV1,
    GeneralErrorV1,
    ProtocolErrorCode,
    ProtocolValidationError,
    validate_form_submit_request,
)
from agent_core.a2ui_http import (
    AuthenticatedPrincipal,
    AuthorizedResolveContext,
    FormAuthorizer,
    PrincipalProvider,
)

from .errors import A2UIProblem, safe_stable_id
from .service import SubmissionPort


logger = logging.getLogger("agent_core.a2ui_submission.http")

SUBMIT_PATH = "/api/a2ui/v1/forms/{formId}/submissions"
SUBMISSION_PATH = "/api/a2ui/v1/submissions/{submissionId}"
_STABLE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def create_submission_router(
    *,
    service: SubmissionPort,
    principal_provider: PrincipalProvider,
    form_authorizer: FormAuthorizer,
) -> APIRouter:
    """Create the optional submission router using explicit trusted host ports.

    The submission path keeps the frozen ordering: authenticate, parse the
    shared envelope, authorize the form, then delegate to a service that looks
    up idempotency before current-form validation.
    """

    _require_port("principal_provider", principal_provider)
    _require_port("form_authorizer", form_authorizer)

    router = APIRouter()

    @router.post(
        SUBMIT_PATH,
        response_model=None,
        responses={
            200: {"model": FormSubmitSuccessV1, "description": "Persisted or replayed submission."},
            400: {"model": FormSubmitErrorV1},
            401: {"model": FormSubmitErrorV1},
            403: {"model": FormSubmitErrorV1},
            409: {"model": FormSubmitErrorV1},
            422: {
                "description": "Field validation failure or current form/action contract error.",
                "content": {
                    "application/json": {
                        "schema": {
                            "oneOf": [
                                {"$ref": "#/components/schemas/FormSubmitValidationErrorV1"},
                                {"$ref": "#/components/schemas/FormSubmitErrorV1"},
                            ]
                        }
                    }
                },
            },
            500: {"model": FormSubmitErrorV1},
        },
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {"application/json": {"schema": FormSubmitRequestV1.model_json_schema()}},
            }
        },
    )
    async def submit_form(formId: str, request: Request) -> JSONResponse:
        principal = await _principal_or_error(
            principal_provider,
            request,
            form_id=safe_stable_id(formId),
        )
        if isinstance(principal, JSONResponse):
            return principal

        parsed = await _parse_submit_request(request, path_form_id=formId)
        if isinstance(parsed, JSONResponse):
            return parsed

        authorization = await _authorize_form(
            form_authorizer,
            principal,
            parsed.form_id,
            request_id=parsed.request_id,
        )
        if isinstance(authorization, JSONResponse):
            return authorization

        try:
            response = service.submit(
                principal=principal,
                form_id_from_path=formId,
                command=parsed,
            )
        except A2UIProblem as exc:
            return JSONResponse(status_code=exc.status_code, content=exc.body())
        except Exception:
            logger.exception("Unhandled A2UI submission failure")
            return _submit_error_response(
                status_code=500,
                request_id=parsed.request_id,
                form_id=parsed.form_id,
                code="INTERNAL_ERROR",
                message="An internal error prevented the request from completing.",
                retryable=True,
            )
        return JSONResponse(status_code=response.status_code, content=response.body)

    @router.get(
        SUBMISSION_PATH,
        response_model=None,
        responses={
            200: {"description": "Submission owned by the authenticated principal."},
            401: {"model": FormSubmitErrorV1},
            403: {"model": FormSubmitErrorV1},
            404: {"model": FormSubmitErrorV1},
            500: {"model": FormSubmitErrorV1},
        },
    )
    async def get_submission(submissionId: str, request: Request) -> JSONResponse:
        principal = await _principal_or_error(principal_provider, request, form_id="unknown")
        if isinstance(principal, JSONResponse):
            return principal
        try:
            response = service.get_submission(principal=principal, submission_id=submissionId)
        except A2UIProblem as exc:
            return JSONResponse(status_code=exc.status_code, content=exc.body())
        except Exception:
            logger.exception("Unhandled A2UI submission read failure")
            return _submit_error_response(
                status_code=500,
                request_id="unknown",
                form_id="unknown",
                code="INTERNAL_ERROR",
                message="An internal error prevented the request from completing.",
                retryable=True,
            )

        authorization = await _authorize_form(
            form_authorizer,
            principal,
            response["formId"],
            request_id="unknown",
        )
        if isinstance(authorization, JSONResponse):
            return authorization
        service.audit_read(principal=principal, response=response)
        return JSONResponse(status_code=200, content=response)

    return router


async def _principal_or_error(
    principal_provider: PrincipalProvider,
    request: Request,
    *,
    form_id: str,
) -> AuthenticatedPrincipal | JSONResponse:
    try:
        principal = await _await_port(principal_provider(request))
    except Exception:
        logger.exception("A2UI principal provider failed")
        return _submit_error_response(
            status_code=500,
            request_id="unknown",
            form_id=form_id,
            code="INTERNAL_ERROR",
            message="An internal error prevented the request from completing.",
            retryable=True,
        )
    if not isinstance(principal, AuthenticatedPrincipal):
        headers = {"Cache-Control": "no-store"}
        challenge = _trusted_authentication_challenge(request)
        if challenge is not None:
            headers["WWW-Authenticate"] = challenge
        return _submit_error_response(
            status_code=401,
            request_id="unknown",
            form_id=form_id,
            code="UNAUTHENTICATED",
            message="Authentication is required.",
            headers=headers,
        )
    return principal


async def _parse_submit_request(
    request: Request,
    *,
    path_form_id: str,
) -> FormSubmitRequestV1 | JSONResponse:
    if "application/json" not in request.headers.get("content-type", "").lower():
        return _submit_error_response(
            status_code=400,
            request_id="unknown",
            form_id=safe_stable_id(path_form_id),
            code="REQUEST_INVALID",
            message="Content-Type must be application/json.",
        )
    payload: Any = None
    try:
        payload = await request.json()
        command = validate_form_submit_request(payload)
    except (json.JSONDecodeError, UnicodeDecodeError, ProtocolValidationError, TypeError, ValueError) as exc:
        code = exc.code.value if isinstance(exc, ProtocolValidationError) else ProtocolErrorCode.REQUEST_INVALID.value
        request_id, body_form_id = _safe_submit_identifiers(payload)
        return _submit_error_response(
            status_code=400,
            request_id=request_id,
            form_id=body_form_id or safe_stable_id(path_form_id),
            code=code,
            message="The request did not match the A2UI submit contract.",
        )
    if command.form_id != path_form_id:
        return _submit_error_response(
            status_code=400,
            request_id=command.request_id,
            form_id=command.form_id,
            code="REQUEST_INVALID",
            message="The path formId must match the request body.",
        )
    return command


async def _authorize_form(
    form_authorizer: FormAuthorizer,
    principal: AuthenticatedPrincipal,
    form_id: str,
    *,
    request_id: str,
) -> AuthorizedResolveContext | JSONResponse:
    try:
        authorized_context = await _await_port(form_authorizer(principal, form_id, None))
    except Exception:
        logger.exception("A2UI form authorizer failed")
        return _submit_error_response(
            status_code=500,
            request_id=request_id,
            form_id=form_id,
            code="INTERNAL_ERROR",
            message="An internal error prevented the request from completing.",
            retryable=True,
        )
    if authorized_context is None:
        return _submit_error_response(
            status_code=403,
            request_id=request_id,
            form_id=form_id,
            code="FORBIDDEN",
            message="The authenticated principal is not authorized for this form.",
            headers={"Cache-Control": "no-store"},
        )
    if not isinstance(authorized_context, AuthorizedResolveContext):
        return _submit_error_response(
            status_code=500,
            request_id=request_id,
            form_id=form_id,
            code="INTERNAL_ERROR",
            message="An internal error prevented the request from completing.",
            retryable=True,
        )
    return authorized_context


def _submit_error_response(
    *,
    status_code: int,
    request_id: str,
    form_id: str,
    code: str,
    message: str,
    retryable: bool = False,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    body = FormSubmitErrorV1(
        schemaVersion="1.0.0",
        requestId=safe_stable_id(request_id),
        formId=safe_stable_id(form_id),
        status="error",
        errors=[GeneralErrorV1(code=code, message=message, retryable=retryable)],
    )
    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(by_alias=True, exclude_none=True),
        headers=dict(headers or {}),
    )


def _safe_submit_identifiers(payload: Any) -> tuple[str, str | None]:
    if not isinstance(payload, Mapping):
        return "unknown", None
    return safe_stable_id(payload.get("requestId")), safe_stable_id(payload.get("formId"))


def _trusted_authentication_challenge(request: Request) -> str | None:
    challenge = getattr(request.state, "www_authenticate", None)
    if isinstance(challenge, str) and challenge and "\r" not in challenge and "\n" not in challenge:
        return challenge
    return None


async def _await_port(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _require_port(name: str, value: object) -> None:
    if not callable(value):
        raise TypeError(f"{name} must be explicitly supplied as a callable port")


__all__ = ["SUBMISSION_PATH", "SUBMIT_PATH", "create_submission_router"]
