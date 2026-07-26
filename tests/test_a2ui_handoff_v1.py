"""Real-route regression evidence for the A2UI v1 frontend handoff.

The tests deliberately compose the existing optional HTTP adapters with trusted
test ports. They prove the frozen contract without turning the test Bearer
tokens or SQLite repository into a production-host prescription.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_core.a2ui import (
    SUPPORTED_COMPONENT_TYPES,
    FormSubmitErrorV1,
    FormSubmitValidationErrorV1,
    validate_api_message,
    validate_form_document,
)
from agent_core.a2ui_http import (
    RESOLVE_PATH,
    AuthenticatedPrincipal,
    AuthorizedResolveContext,
    create_a2ui_app,
)
from agent_core.a2ui_submission.forms import InMemoryFormRegistry
from agent_core.a2ui_submission.http import (
    SUBMISSION_PATH,
    SUBMIT_PATH,
    create_submission_router,
)
from agent_core.a2ui_submission.repository import SQLiteSubmissionRepository
from agent_core.a2ui_submission.service import SubmissionService


ROOT = Path(__file__).resolve().parents[1]
EXAMPLES_PATH = ROOT / "docs/a2ui/v1/form-examples-v1.json"
APPROVED_FIXTURE_REVISIONS = {
    "single-field-update": 1,
    "conditional-application": 3,
    "remote-options-application": 2,
}
WRITER = AuthenticatedPrincipal(subject_id="handoff-writer", tenant_id="handoff-tenant")
BLOCKED = AuthenticatedPrincipal(subject_id="handoff-blocked", tenant_id="handoff-tenant")


class TokenPrincipalProvider:
    """Small trusted host port used only to exercise the public adapters."""

    def __init__(self) -> None:
        self._principals = {"writer": WRITER, "blocked": BLOCKED}

    def __call__(self, request: Any) -> AuthenticatedPrincipal | None:
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not token:
            return None
        return self._principals.get(token)


class FixtureAuthorizer:
    """Authorize the approved fixture set and reject the blocked test subject."""

    def __call__(
        self,
        principal: AuthenticatedPrincipal,
        form_key: str,
        _untrusted_context: Any,
    ) -> AuthorizedResolveContext | None:
        if principal == BLOCKED:
            return None
        return AuthorizedResolveContext({"formKey": form_key})


@dataclass
class HandoffComponents:
    app: Any
    repository: SQLiteSubmissionRepository
    service: SubmissionService
    documents: dict[str, dict[str, Any]]


def _documents() -> dict[str, dict[str, Any]]:
    bundle = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))
    return {document["formId"]: document for document in bundle["examples"]}


def _components(tmp_path: Path) -> HandoffComponents:
    documents = _documents()
    assert set(documents) == set(APPROVED_FIXTURE_REVISIONS)

    registry = InMemoryFormRegistry.from_documents(
        [validate_form_document(document) for document in documents.values()]
    )
    repository = SQLiteSubmissionRepository(
        f"sqlite:///{(tmp_path / 'handoff-submissions.db').as_posix()}"
    )
    repository.migrate()
    service = SubmissionService(repository=repository, forms=registry)
    provider = TokenPrincipalProvider()
    authorizer = FixtureAuthorizer()

    def resolver(
        _principal: AuthenticatedPrincipal,
        context: AuthorizedResolveContext,
    ) -> dict[str, Any]:
        return documents[context.values["formKey"]]

    app = create_a2ui_app(
        principal_provider=provider,
        form_authorizer=authorizer,
        form_resolver=resolver,
    )
    app.include_router(
        create_submission_router(
            service=service,
            principal_provider=provider,
            form_authorizer=authorizer,
        )
    )
    return HandoffComponents(
        app=app,
        repository=repository,
        service=service,
        documents=documents,
    )


@pytest.fixture
def handoff_components(tmp_path: Path) -> HandoffComponents:
    return _components(tmp_path)


def _headers(token: str = "writer") -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _resolve_request(form_id: str) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0.0",
        "requestId": f"handoff-resolve-{form_id}",
        "formKey": form_id,
        "client": {
            "supportedSchemaVersions": ["1.0.0"],
            "supportedComponents": sorted(SUPPORTED_COMPONENT_TYPES),
        },
    }


def _submit_request(
    *,
    request_id: str = "handoff-submit-001",
    idempotency_key: str = "handoff-idem-001",
    phone: str = "13800138000",
) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0.0",
        "requestId": request_id,
        "idempotencyKey": idempotency_key,
        "formId": "single-field-update",
        "revision": 1,
        "action": {
            "actionId": "submit-single-field",
            "sourceComponentId": "single-field-submit",
        },
        "data": {"profile": {"phone": phone}},
    }


@pytest.mark.parametrize("form_id", sorted(APPROVED_FIXTURE_REVISIONS))
def test_every_approved_fixture_resolves_through_the_real_router(
    handoff_components: HandoffComponents,
    form_id: str,
) -> None:
    """The frontend can obtain every frozen fixture through the HTTP adapter."""

    with TestClient(handoff_components.app) as client:
        response = client.post(
            RESOLVE_PATH,
            json=_resolve_request(form_id),
            headers=_headers(),
        )

    assert response.status_code == 200
    document = validate_form_document(response.json())
    assert document.form_id == form_id
    assert document.revision == APPROVED_FIXTURE_REVISIONS[form_id]
    assert document.request_id == f"handoff-resolve-{form_id}"


def test_resolve_publicly_reports_version_and_component_capability_mismatches(
    handoff_components: HandoffComponents,
) -> None:
    unsupported_version = _resolve_request("single-field-update")
    unsupported_version["schemaVersion"] = "1.0.1"
    unsupported_client = _resolve_request("single-field-update")
    unsupported_client["client"]["supportedSchemaVersions"] = ["2.0.0"]
    unsupported_components = _resolve_request("single-field-update")
    unsupported_components["client"]["supportedComponents"] = ["Form"]

    with TestClient(handoff_components.app) as client:
        invalid_schema = client.post(RESOLVE_PATH, json=unsupported_version, headers=_headers())
        version_mismatch = client.post(
            RESOLVE_PATH,
            json=unsupported_client,
            headers=_headers(),
        )
        component_mismatch = client.post(
            RESOLVE_PATH,
            json=unsupported_components,
            headers=_headers(),
        )

    assert invalid_schema.status_code == 400
    assert validate_api_message(invalid_schema.json()).errors[0].code == "SCHEMA_VERSION_UNSUPPORTED"
    assert version_mismatch.status_code == 422
    assert validate_api_message(version_mismatch.json()).errors[0].code == "CLIENT_CAPABILITY_MISMATCH"
    assert component_mismatch.status_code == 422
    assert validate_api_message(component_mismatch.json()).errors[0].code == "CLIENT_CAPABILITY_MISMATCH"


def test_invalid_resolver_schema_never_reaches_the_client() -> None:
    invalid_document = copy.deepcopy(_documents()["single-field-update"])
    invalid_document["root"]["children"][0]["children"][0]["props"]["script"] = "never-run"

    app = create_a2ui_app(
        principal_provider=lambda _request: WRITER,
        form_authorizer=lambda *_args: AuthorizedResolveContext(),
        form_resolver=lambda *_args: invalid_document,
    )
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post(
            RESOLVE_PATH,
            json=_resolve_request("single-field-update"),
        )

    assert response.status_code == 500
    parsed = validate_api_message(response.json())
    assert parsed.errors[0].code == "INTERNAL_ERROR"
    assert "never-run" not in response.text



def test_model_resolver_preserves_explicit_null_set_value_effect() -> None:
    conditional = validate_form_document(_documents()["conditional-application"])
    app = create_a2ui_app(
        principal_provider=lambda _request: WRITER,
        form_authorizer=lambda *_args: AuthorizedResolveContext(),
        form_resolver=lambda *_args: conditional,
    )
    with TestClient(app) as client:
        response = client.post(
            RESOLVE_PATH,
            json=_resolve_request("conditional-application"),
        )

    assert response.status_code == 200
    validate_form_document(response.json())
    assert response.json()["rules"][0]["else"][2] == {
        "type": "setValue",
        "targetDataPath": "/identity/companyName",
        "value": None,
    }

@pytest.mark.parametrize(
    ("path", "payload"),
    [
        (RESOLVE_PATH, _resolve_request("single-field-update")),
        (SUBMIT_PATH.format(formId="single-field-update"), _submit_request()),
    ],
)
def test_resolve_and_submit_keep_401_and_403_at_the_host_boundary(
    handoff_components: HandoffComponents,
    path: str,
    payload: dict[str, Any],
) -> None:
    with TestClient(handoff_components.app) as client:
        unauthenticated = client.post(path, json=payload)
        forbidden = client.post(path, json=payload, headers=_headers("blocked"))

    assert unauthenticated.status_code == 401
    assert validate_api_message(unauthenticated.json()).errors[0].code == "UNAUTHENTICATED"
    assert unauthenticated.headers["cache-control"] == "no-store"
    assert forbidden.status_code == 403
    assert validate_api_message(forbidden.json()).errors[0].code == "FORBIDDEN"
    assert forbidden.headers["cache-control"] == "no-store"


def test_successful_submit_then_owner_read_and_read_auth_errors(
    handoff_components: HandoffComponents,
) -> None:
    path = SUBMIT_PATH.format(formId="single-field-update")
    with TestClient(handoff_components.app) as client:
        created = client.post(path, json=_submit_request(), headers=_headers())
        submission_id = created.json()["result"]["submissionId"]
        read = client.get(SUBMISSION_PATH.format(submissionId=submission_id), headers=_headers())
        missing_auth = client.get(SUBMISSION_PATH.format(submissionId=submission_id))
        absent = client.get(
            SUBMISSION_PATH.format(submissionId="submission-does-not-exist"),
            headers=_headers(),
        )

    assert created.status_code == 200
    assert validate_api_message(created.json()).status == "success"
    assert read.status_code == 200
    assert read.json()["submissionId"] == submission_id
    assert read.json()["formId"] == "single-field-update"
    assert read.json()["data"] == {"profile": {"phone": "13800138000"}}
    assert missing_auth.status_code == 401
    assert FormSubmitErrorV1.model_validate(missing_auth.json()).errors[0].code == "UNAUTHENTICATED"
    assert missing_auth.headers["cache-control"] == "no-store"
    assert absent.status_code == 404
    assert FormSubmitErrorV1.model_validate(absent.json()).errors[0].code == "SUBMISSION_NOT_FOUND"


def test_field_and_generic_submission_failures_have_distinct_safe_envelopes(
    handoff_components: HandoffComponents,
) -> None:
    class ExplodingRegistry:
        def get(self, _form_id: str) -> None:
            raise RuntimeError("internal test-only failure")

    path = SUBMIT_PATH.format(formId="single-field-update")
    with TestClient(handoff_components.app) as client:
        field_error = client.post(
            path,
            json=_submit_request(idempotency_key="handoff-field-error", phone="invalid-phone"),
            headers=_headers(),
        )
        handoff_components.service.forms = ExplodingRegistry()
        generic_error = client.post(
            path,
            json=_submit_request(idempotency_key="handoff-generic-error"),
            headers=_headers(),
        )

    assert field_error.status_code == 422
    field_envelope = FormSubmitValidationErrorV1.model_validate(field_error.json())
    assert "/profile/phone" in field_envelope.field_errors
    assert generic_error.status_code == 500
    generic_envelope = FormSubmitErrorV1.model_validate(generic_error.json())
    assert generic_envelope.errors[0].code == "INTERNAL_ERROR"
    assert "internal test-only failure" not in generic_error.text
    assert handoff_components.repository.count_submissions() == 0


def test_submit_transport_rejections_and_idempotency_replay_are_stable(
    handoff_components: HandoffComponents,
) -> None:
    path = SUBMIT_PATH.format(formId="single-field-update")
    unsupported_version = _submit_request(idempotency_key="handoff-version-error")
    unsupported_version["schemaVersion"] = "1.0.1"
    path_mismatch = _submit_request(idempotency_key="handoff-path-error")

    with TestClient(handoff_components.app) as client:
        version_error = client.post(path, json=unsupported_version, headers=_headers())
        mismatch_error = client.post(
            SUBMIT_PATH.format(formId="a-different-form"),
            json=path_mismatch,
            headers=_headers(),
        )
        first = client.post(path, json=_submit_request(), headers=_headers())
        replay = client.post(
            path,
            json=_submit_request(request_id="handoff-submit-retry"),
            headers=_headers(),
        )
        conflict = client.post(
            path,
            json=_submit_request(phone="13900139000"),
            headers=_headers(),
        )

    assert version_error.status_code == 400
    assert FormSubmitErrorV1.model_validate(version_error.json()).errors[0].code == "SCHEMA_VERSION_UNSUPPORTED"
    assert mismatch_error.status_code == 400
    assert FormSubmitErrorV1.model_validate(mismatch_error.json()).errors[0].code == "REQUEST_INVALID"
    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json()["result"] == first.json()["result"]
    assert conflict.status_code == 409
    assert FormSubmitErrorV1.model_validate(conflict.json()).errors[0].code == "IDEMPOTENCY_KEY_CONFLICT"
    assert handoff_components.repository.count_submissions() == 1


def test_openapi_exposes_the_three_frontend_handoff_operations(
    handoff_components: HandoffComponents,
) -> None:
    paths = handoff_components.app.openapi()["paths"]

    assert "post" in paths[RESOLVE_PATH]
    assert "post" in paths[SUBMIT_PATH]
    assert "get" in paths[SUBMISSION_PATH]
