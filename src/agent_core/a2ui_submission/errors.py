"""Internal failures rendered through the shared A2UI v1 response models."""

from __future__ import annotations

import re
from typing import Any

from agent_core.a2ui import (
    FieldErrorV1,
    FormSubmitErrorV1,
    FormSubmitValidationErrorV1,
    GeneralErrorV1,
)


_STABLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def safe_stable_id(value: object, fallback: str = "unknown") -> str:
    """Never echo malformed client/path identifiers in a frozen envelope."""

    return value if isinstance(value, str) and _STABLE_ID.fullmatch(value) else fallback


class A2UIProblem(Exception):
    """Internal control flow; its wire body always uses PR #6 models."""

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        retryable: bool = False,
        request_id: str | None = None,
        form_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable
        self.request_id = safe_stable_id(request_id)
        self.form_id = safe_stable_id(form_id)

    def body(self) -> dict[str, Any]:
        return FormSubmitErrorV1(
            schemaVersion="1.0.0",
            requestId=self.request_id,
            formId=self.form_id,
            status="error",
            errors=[
                GeneralErrorV1(
                    code=self.code,
                    message=self.message,
                    retryable=self.retryable,
                )
            ],
        ).model_dump(by_alias=True, exclude_none=True)


class FieldValidationProblem(A2UIProblem):
    def __init__(
        self,
        *,
        field_errors: dict[str, list[dict[str, str]]],
        request_id: str,
        form_id: str,
    ) -> None:
        super().__init__(
            status_code=422,
            code="REQUEST_INVALID",
            message="Submitted form data did not pass server validation.",
            request_id=request_id,
            form_id=form_id,
        )
        self.field_errors = field_errors

    def body(self) -> dict[str, Any]:
        fields = {
            path: [FieldErrorV1(code=item["code"], message=item["message"]) for item in errors]
            for path, errors in self.field_errors.items()
        }
        return FormSubmitValidationErrorV1(
            schemaVersion="1.0.0",
            requestId=self.request_id,
            formId=self.form_id,
            status="validation_error",
            fieldErrors=fields,
            errors=[],
        ).model_dump(by_alias=True, exclude_none=True)
