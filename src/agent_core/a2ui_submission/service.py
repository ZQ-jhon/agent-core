"""Transactional A2UI submission orchestration and idempotency semantics."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

from agent_core.a2ui import (
    A2UI_FORM_SCHEMA_VERSION,
    FormSubmitRequestV1,
    FormSubmitSuccessV1,
    SubmitResult,
)

from .errors import A2UIProblem, FieldValidationProblem
from .forms import (
    EmptyFormRegistry,
    FileReferenceVerifier,
    FormRegistry,
    RemoteOptionVerifier,
    SubmissionPrincipal,
    UnknownSubmissionDataPath,
    validate_submission_data,
)
from .repository import (
    IdempotencyScope,
    SQLiteSubmissionRepository,
    StoredSubmission,
    utc_now,
)


logger = logging.getLogger("agent_core.a2ui.audit")


@dataclass(frozen=True)
class ServiceResponse:
    status_code: int
    body: dict[str, Any]
    replayed: bool = False


class SubmissionPort(Protocol):
    """The ISSUE-16 boundary consumed by the optional HTTP adapter.

    The transport layer depends on this port rather than on SQLite.  The
    existing ``SubmissionService`` is its production implementation; hosts
    may substitute another implementation with the same frozen idempotency,
    failure, and owner-isolation semantics.
    """

    def submit(
        self,
        *,
        principal: SubmissionPrincipal,
        form_id_from_path: str,
        command: FormSubmitRequestV1,
    ) -> ServiceResponse: ...

    def get_submission(
        self,
        *,
        principal: SubmissionPrincipal,
        submission_id: str,
    ) -> dict[str, Any]: ...

    def audit_read(
        self,
        *,
        principal: SubmissionPrincipal,
        response: dict[str, Any],
    ) -> None: ...


class SubmissionService:
    def __init__(
        self,
        *,
        repository: SQLiteSubmissionRepository,
        forms: FormRegistry | None = None,
        file_reference_verifier: FileReferenceVerifier | None = None,
        remote_option_verifier: RemoteOptionVerifier | None = None,
    ) -> None:
        self.repository = repository
        self.forms = forms or EmptyFormRegistry()
        self.file_reference_verifier = file_reference_verifier
        self.remote_option_verifier = remote_option_verifier

    def submit(
        self,
        *,
        principal: SubmissionPrincipal,
        form_id_from_path: str,
        command: FormSubmitRequestV1,
    ) -> ServiceResponse:
        if form_id_from_path != command.form_id:
            raise A2UIProblem(
                status_code=400,
                code="REQUEST_INVALID",
                message="The path formId must match the request body.",
                request_id=command.request_id,
                form_id=command.form_id,
            )

        fingerprint = request_fingerprint(command)
        scope = IdempotencyScope(
            tenant_id=principal.tenant_id,
            subject_id=principal.subject_id,
            form_id=command.form_id,
            revision=command.revision,
            action_id=command.action.action_id,
            idempotency_key=command.idempotency_key,
        )

        with self.repository.write_transaction() as connection:
            existing = self.repository.find_by_idempotency(connection, scope)
            if existing is not None:
                if existing.request_fingerprint != fingerprint:
                    raise A2UIProblem(
                        status_code=409,
                        code="IDEMPOTENCY_KEY_CONFLICT",
                        message="The idempotency key was already used for a different request.",
                        request_id=command.request_id,
                        form_id=command.form_id,
                    )
                if existing.state != "completed" or existing.response_body is None:
                    raise A2UIProblem(
                        status_code=409,
                        code="SUBMISSION_IN_PROGRESS",
                        message="The matching submission is still being processed.",
                        retryable=True,
                        request_id=command.request_id,
                        form_id=command.form_id,
                    )
                self._audit(
                    "submission_replayed",
                    command,
                    principal,
                    existing.submission_id,
                    result_code="SUCCESS_REPLAY",
                )
                return ServiceResponse(
                    status_code=existing.response_status or 200,
                    body=existing.response_body,
                    replayed=True,
                )

            # The frozen contract requires all current-form validation to happen
            # only after the idempotency lookup above.
            snapshot = self.forms.get(command.form_id)
            if snapshot is None or snapshot.revision != command.revision:
                raise A2UIProblem(
                    status_code=409,
                    code="FORM_REVISION_CONFLICT",
                    message="The form revision is no longer current.",
                    retryable=True,
                    request_id=command.request_id,
                    form_id=command.form_id,
                )

            action = snapshot.actions.get(command.action.action_id)
            if (
                action is None
                or action.action_type != "submit"
                or command.action.source_component_id not in action.source_component_ids
            ):
                raise A2UIProblem(
                    status_code=422,
                    code="SCHEMA_INVALID",
                    message="The submit action is not valid for the current form revision.",
                    request_id=command.request_id,
                    form_id=command.form_id,
                )

            try:
                validation = validate_submission_data(
                    snapshot=snapshot,
                    principal=principal,
                    data=command.data,
                    file_reference_verifier=self.file_reference_verifier,
                    remote_option_verifier=self.remote_option_verifier,
                )
            except UnknownSubmissionDataPath:
                raise A2UIProblem(
                    status_code=400,
                    code="REQUEST_INVALID",
                    message="This data field is not declared by the current form revision.",
                    request_id=command.request_id,
                    form_id=command.form_id,
                ) from None
            if validation.field_errors:
                raise FieldValidationProblem(
                    field_errors=validation.field_errors,
                    request_id=command.request_id,
                    form_id=command.form_id,
                )

            submission_id = f"submission-{uuid.uuid4().hex}"
            audit_id = f"audit-{uuid.uuid4().hex}"
            now = utc_now()
            response_body = FormSubmitSuccessV1(
                schemaVersion="1.0.0",
                requestId=command.request_id,
                formId=command.form_id,
                status="success",
                result=SubmitResult(submissionId=submission_id),
            ).model_dump(by_alias=True, exclude_none=True)
            self.repository.insert(
                connection,
                StoredSubmission(
                    submission_id=submission_id,
                    tenant_id=principal.tenant_id,
                    subject_id=principal.subject_id,
                    form_id=command.form_id,
                    revision=command.revision,
                    action_id=command.action.action_id,
                    source_component_id=command.action.source_component_id,
                    idempotency_key=command.idempotency_key,
                    request_fingerprint=fingerprint,
                    state="completed",
                    data=validation.data,
                    file_references=validation.file_references,
                    response_status=200,
                    response_body=response_body,
                    request_id=command.request_id,
                    audit_id=audit_id,
                    created_at=now,
                    updated_at=now,
                ),
            )
            self._audit(
                "submission_completed",
                command,
                principal,
                submission_id,
                result_code="SUCCESS",
            )
            return ServiceResponse(status_code=200, body=response_body)

    def get_submission(
        self,
        *,
        principal: SubmissionPrincipal,
        submission_id: str,
    ) -> dict[str, Any]:
        stored = self.repository.get_for_owner(
            submission_id=submission_id,
            tenant_id=principal.tenant_id,
            subject_id=principal.subject_id,
        )
        # A foreign record has the same response as an absent record to avoid an
        # ownership/tenant existence leak.
        if stored is None:
            raise A2UIProblem(
                status_code=404,
                code="SUBMISSION_NOT_FOUND",
                message="The submission was not found.",
            )
        return {
            "submissionId": stored.submission_id,
            "formId": stored.form_id,
            "revision": stored.revision,
            "action": {
                "actionId": stored.action_id,
                "sourceComponentId": stored.source_component_id,
            },
            "data": stored.data,
            "status": "completed",
            "auditId": stored.audit_id,
            "createdAt": stored.created_at,
            "updatedAt": stored.updated_at,
        }

    def audit_read(
        self,
        *,
        principal: SubmissionPrincipal,
        response: dict[str, Any],
    ) -> None:
        """Record a successful read only after the host authorizer allows it."""

        self._audit(
            "submission_read",
            None,
            principal,
            response["submissionId"],
            response["formId"],
            "unknown",
            response["revision"],
            "SUCCESS",
        )

    @staticmethod
    def _audit(
        event: str,
        command: FormSubmitRequestV1 | None,
        principal: SubmissionPrincipal,
        submission_id: str,
        form_id: str | None = None,
        request_id: str | None = None,
        revision: int | None = None,
        result_code: str = "SUCCESS",
    ) -> None:
        # Keep logs structured and intentionally omit form data, tokens, and
        # file metadata.
        logger.info(
            json.dumps(
                {
                    "event": event,
                    "requestId": request_id or (command.request_id if command else "unknown"),
                    "formId": form_id or (command.form_id if command else "unknown"),
                    "schemaVersion": command.schema_version if command else A2UI_FORM_SCHEMA_VERSION,
                    "revision": revision if revision is not None else (command.revision if command else None),
                    "subjectId": principal.subject_id,
                    "tenantId": principal.tenant_id,
                    "submissionId": submission_id,
                    "resultCode": result_code,
                },
                separators=(",", ":"),
            )
        )


def request_fingerprint(command: FormSubmitRequestV1) -> str:
    """Hash the exact contract-defined canonical request projection."""

    try:
        projection = {
            "schemaVersion": command.schema_version,
            "formId": command.form_id,
            "revision": command.revision,
            "action": command.action.model_dump(by_alias=True, exclude_none=True),
            "data": _normalize_numbers(command.data),
        }
        canonical = json.dumps(
            projection,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise A2UIProblem(
            status_code=400,
            code="REQUEST_INVALID",
            message="The request contains a non-JSON value.",
            request_id=command.request_id,
            form_id=command.form_id,
        ) from error
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _normalize_numbers(value: Any) -> Any:
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite numbers are not JSON values")
        return int(value) if value.is_integer() else value
    if isinstance(value, dict):
        return {key: _normalize_numbers(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_normalize_numbers(child) for child in value]
    return value
