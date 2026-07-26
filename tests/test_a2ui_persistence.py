from __future__ import annotations

import copy
import importlib
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import agent_core
from agent_core.a2ui import (
    FormSubmitErrorV1,
    FormSubmitValidationErrorV1,
    ProtocolValidationError,
    SUPPORTED_COMPONENT_TYPES,
    validate_form_document,
    validate_form_submit_request,
)
from agent_core.a2ui_http import (
    RESOLVE_PATH,
    AuthenticatedPrincipal,
    AuthorizedResolveContext,
    create_a2ui_app,
)
from agent_core.a2ui_submission.forms import (
    FieldDefinition,
    FormSnapshot,
    InMemoryFormRegistry,
    build_form_snapshot,
    validate_submission_data,
)
from agent_core.a2ui_submission.http import create_submission_router
from agent_core.a2ui_submission.repository import SQLiteSubmissionRepository
from agent_core.a2ui_submission.service import ServiceResponse, SubmissionService


ROOT = Path(__file__).resolve().parents[1]
EXAMPLES_PATH = ROOT / "docs/a2ui/v1/form-examples-v1.json"
SUBMIT_PATH = "/api/a2ui/v1/forms/single-field-update/submissions"


def _single_field_document() -> dict:
    examples = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))["examples"]
    return next(example for example in examples if example["formId"] == "single-field-update")


def _conditional_document() -> dict:
    examples = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))["examples"]
    return next(example for example in examples if example["formId"] == "conditional-application")


def _payload(
    *,
    request_id: str = "request-001",
    idempotency_key: str = "idem-001",
    phone: str = "13800138000",
) -> dict:
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


def _conditional_payload(*, idempotency_key: str = "idem-conditional-001") -> dict:
    return {
        "schemaVersion": "1.0.0",
        "requestId": "request-conditional-001",
        "idempotencyKey": idempotency_key,
        "formId": "conditional-application",
        "revision": 3,
        "action": {
            "actionId": "submit-linked",
            "sourceComponentId": "linked-submit",
        },
        # The frozen client behavior omits the disabled, hidden company field.
        "data": {
            "identity": {"personType": "employee", "workEmail": "person@example.com"},
            "access": {"startDate": "2026-08-01", "level": "write"},
            "preferences": {"notify": True},
        },
    }


def _resolve_payload() -> dict:
    return {
        "schemaVersion": "1.0.0",
        "requestId": "resolve-001",
        "formKey": "single-field-update",
        "client": {
            "supportedSchemaVersions": ["1.0.0"],
            "supportedComponents": sorted(SUPPORTED_COMPONENT_TYPES),
        },
    }


def _headers(token: str = "writer") -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


class TokenPrincipalProvider:
    """A test host implementation of PR #8's PrincipalProvider port."""

    def __init__(self, principals: dict[str, AuthenticatedPrincipal]) -> None:
        self._principals = dict(principals)

    def __call__(self, request):
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not token:
            return None
        return self._principals.get(token)


@dataclass
class FormPolicy:
    """A test host implementation of PR #8's FormAuthorizer port."""

    denied_subjects: set[str] = field(default_factory=set)
    calls: int = 0

    def __call__(self, principal, form_key, _untrusted_context):
        self.calls += 1
        if principal.subject_id in self.denied_subjects:
            return None
        return AuthorizedResolveContext({"formKey": form_key})


class ExampleResolver:
    def __init__(self, document) -> None:
        self._document = document

    def __call__(self, _principal, _authorized_context):
        return self._document


@dataclass
class Components:
    app: object
    registry: InMemoryFormRegistry
    repository: SQLiteSubmissionRepository
    service: SubmissionService
    provider: TokenPrincipalProvider
    authorizer: FormPolicy
    document: object
    database_url: str


class RecordingSubmissionPort:
    """A transport-test substitute for ISSUE-16's persistence port."""

    def __init__(self) -> None:
        self.submissions: list[tuple[AuthenticatedPrincipal, str, object]] = []

    def submit(self, *, principal, form_id_from_path, command) -> ServiceResponse:
        self.submissions.append((principal, form_id_from_path, command))
        return ServiceResponse(
            status_code=200,
            body={
                "schemaVersion": "1.0.0",
                "requestId": command.request_id,
                "formId": command.form_id,
                "status": "success",
                "result": {"submissionId": "submission-port-stub"},
            },
        )

    def get_submission(self, *, principal, submission_id):
        raise AssertionError("GET is outside this submit-port test")

    def audit_read(self, *, principal, response) -> None:
        raise AssertionError("GET is outside this submit-port test")


def _compose_app(
    *,
    service: SubmissionService,
    provider: TokenPrincipalProvider,
    authorizer: FormPolicy,
    document,
):
    app = create_a2ui_app(
        principal_provider=provider,
        form_authorizer=authorizer,
        form_resolver=ExampleResolver(document),
    )
    app.include_router(
        create_submission_router(
            service=service,
            principal_provider=provider,
            form_authorizer=authorizer,
        )
    )
    return app


def _components(tmp_path: Path, *, forms=None) -> Components:
    document = validate_form_document(_single_field_document())
    registry = forms or InMemoryFormRegistry.from_documents([document])
    database_url = f"sqlite:///{(tmp_path / 'submissions.db').as_posix()}"
    repository = SQLiteSubmissionRepository(database_url)
    repository.migrate()
    service = SubmissionService(repository=repository, forms=registry)
    provider = TokenPrincipalProvider(
        {
            "writer": AuthenticatedPrincipal(subject_id="user-a", tenant_id="tenant-a"),
            "other": AuthenticatedPrincipal(subject_id="user-b", tenant_id="tenant-a"),
            "blocked": AuthenticatedPrincipal(subject_id="blocked-user", tenant_id="tenant-a"),
        }
    )
    authorizer = FormPolicy(denied_subjects={"blocked-user"})
    app = _compose_app(
        service=service,
        provider=provider,
        authorizer=authorizer,
        document=document,
    )
    return Components(app, registry, repository, service, provider, authorizer, document, database_url)


def test_real_combined_tree_imports_resolves_and_persists(tmp_path: Path) -> None:
    profile = importlib.import_module("agent_core.a2ui")
    host = importlib.import_module("agent_core.a2ui_http")
    persistence = importlib.import_module("agent_core.a2ui_submission")
    submission_http = importlib.import_module("agent_core.a2ui_submission.http")

    assert Path(profile.__file__).name == "a2ui.py"
    assert hasattr(host, "create_a2ui_app")
    assert hasattr(persistence, "SubmissionService")
    assert hasattr(submission_http, "create_submission_router")
    assert callable(agent_core.run)

    components = _components(tmp_path)
    with TestClient(components.app) as client:
        resolved = client.post(RESOLVE_PATH, json=_resolve_payload(), headers=_headers())
        created = client.post(SUBMIT_PATH, json=_payload(), headers=_headers())
        submission_id = created.json()["result"]["submissionId"]
        read = client.get(f"/api/a2ui/v1/submissions/{submission_id}", headers=_headers())

    assert resolved.status_code == 200
    assert created.status_code == 200
    assert read.status_code == 200
    assert read.headers["cache-control"] == "no-store"
    assert read.json()["data"] == {"profile": {"phone": "13800138000"}}


def test_field_error_uses_shared_validation_envelope_without_write(tmp_path: Path) -> None:
    components = _components(tmp_path)
    with TestClient(components.app) as client:
        response = client.post(SUBMIT_PATH, json=_payload(phone="invalid-phone"), headers=_headers())

    assert response.status_code == 422
    parsed = FormSubmitValidationErrorV1.model_validate(response.json())
    assert parsed.status == "validation_error"
    assert "/profile/phone" in parsed.field_errors
    assert components.repository.count_submissions() == 0


def test_field_validation_uses_frozen_default_codes() -> None:
    principal = AuthenticatedPrincipal(subject_id="user-a", tenant_id="tenant-a")
    cases = [
        ("TextInput", "ok", {"type": "required"}, "", "FIELD_REQUIRED"),
        ("TextInput", "ok", {"type": "minLength", "value": 3}, "x", "STRING_TOO_SHORT"),
        ("TextInput", "ok", {"type": "maxLength", "value": 2}, "toolong", "STRING_TOO_LONG"),
        ("TextInput", "ok", {"type": "pattern", "value": "^[0-9]+$"}, "x", "PATTERN_MISMATCH"),
        ("NumberInput", 1, {"type": "minimum", "value": 1}, 0, "NUMBER_TOO_SMALL"),
        ("NumberInput", 1, {"type": "maximum", "value": 2}, 3, "NUMBER_TOO_LARGE"),
        ("NumberInput", 1, {"type": "integer"}, 1.5, "INTEGER_REQUIRED"),
        ("CheckboxGroup", ["x"], {"type": "minItems", "value": 1}, [], "ARRAY_TOO_SHORT"),
        ("CheckboxGroup", ["x"], {"type": "maxItems", "value": 1}, ["x", "y"], "ARRAY_TOO_LONG"),
    ]

    for component_type, initial_value, validator, invalid_value, expected_code in cases:
        field = FieldDefinition(
            data_path="/value",
            component_id="field",
            component_type=component_type,
            validations=(validator,),
            props={},
            data_source_id=None,
        )
        snapshot = FormSnapshot(
            form_id="validation-fixture",
            revision=1,
            initial_values={"value": initial_value},
            actions={},
            fields={"/value": field},
            rules=(),
            component_states={"field": (True, False)},
        )
        result = validate_submission_data(
            snapshot=snapshot,
            principal=principal,
            data={"value": invalid_value},
            file_reference_verifier=None,
            remote_option_verifier=None,
        )
        assert result.field_errors["/value"][0]["code"] == expected_code


def test_hidden_conditional_field_may_be_omitted_from_submit_data(tmp_path: Path) -> None:
    conditional = validate_form_document(_conditional_document())
    components = _components(
        tmp_path,
        forms=InMemoryFormRegistry.from_documents([conditional]),
    )
    path = "/api/a2ui/v1/forms/conditional-application/submissions"

    with TestClient(components.app) as client:
        response = client.post(path, json=_conditional_payload(), headers=_headers())

    assert response.status_code == 200
    assert components.repository.count_submissions() == 1


def test_unknown_data_path_is_request_error_after_idempotency_lookup(tmp_path: Path) -> None:
    components = _components(tmp_path)
    unknown = _payload(idempotency_key="idem-unknown-data")
    unknown["data"]["profile"]["unexpected"] = "not declared"

    with TestClient(components.app) as client:
        fresh = client.post(SUBMIT_PATH, json=unknown, headers=_headers())
        created = client.post(SUBMIT_PATH, json=_payload(idempotency_key="idem-existing"), headers=_headers())
        existing_key = _payload(idempotency_key="idem-existing")
        existing_key["data"]["profile"]["unexpected"] = "not declared"
        conflict = client.post(SUBMIT_PATH, json=existing_key, headers=_headers())

    assert fresh.status_code == 400
    assert FormSubmitErrorV1.model_validate(fresh.json()).errors[0].code == "REQUEST_INVALID"
    assert conflict.status_code == 409
    assert FormSubmitErrorV1.model_validate(conflict.json()).errors[0].code == "IDEMPOTENCY_KEY_CONFLICT"
    assert created.status_code == 200
    assert components.repository.count_submissions() == 1


def test_unknown_action_is_schema_error_after_fresh_idempotency_lookup(tmp_path: Path) -> None:
    components = _components(tmp_path)
    invalid = _payload(idempotency_key="idem-unknown-action")
    invalid["action"]["actionId"] = "missing-submit-action"

    with TestClient(components.app) as client:
        response = client.post(SUBMIT_PATH, json=invalid, headers=_headers())

    assert response.status_code == 422
    assert FormSubmitErrorV1.model_validate(response.json()).errors[0].code == "SCHEMA_INVALID"
    assert components.repository.count_submissions() == 0


def test_submit_openapi_declares_field_and_general_422_envelopes(tmp_path: Path) -> None:
    components = _components(tmp_path)
    route_path = "/api/a2ui/v1/forms/{formId}/submissions"
    schema = components.app.openapi()["paths"][route_path]["post"]["responses"]["422"]

    assert schema["description"] == "Field validation failure or current form/action contract error."
    refs = {
        item["$ref"]
        for item in schema["content"]["application/json"]["schema"]["oneOf"]
    }
    assert refs == {
        "#/components/schemas/FormSubmitValidationErrorV1",
        "#/components/schemas/FormSubmitErrorV1",
    }


def test_submit_router_consumes_submission_port_without_sqlite(tmp_path: Path) -> None:
    port = RecordingSubmissionPort()
    document = validate_form_document(_single_field_document())
    provider = TokenPrincipalProvider(
        {"writer": AuthenticatedPrincipal(subject_id="user-a", tenant_id="tenant-a")}
    )
    authorizer = FormPolicy()
    app = _compose_app(
        service=port,
        provider=provider,
        authorizer=authorizer,
        document=document,
    )

    with TestClient(app) as client:
        response = client.post(SUBMIT_PATH, json=_payload(), headers=_headers())

    assert response.status_code == 200
    assert response.json()["result"]["submissionId"] == "submission-port-stub"
    assert len(port.submissions) == 1
    principal, path_form_id, command = port.submissions[0]
    assert principal == AuthenticatedPrincipal(subject_id="user-a", tenant_id="tenant-a")
    assert path_form_id == "single-field-update"
    assert command.idempotency_key == "idem-001"


def test_unauthenticated_submit_uses_path_form_id_without_parsing_body() -> None:
    service = RecordingSubmissionPort()
    document = validate_form_document(_single_field_document())
    authorizer = FormPolicy()
    app = _compose_app(
        service=service,
        provider=TokenPrincipalProvider({}),
        authorizer=authorizer,
        document=document,
    )
    payload = _payload(request_id="body-request-id")
    payload["formId"] = "conflicting-body-form-id"

    with TestClient(app) as client:
        response = client.post(SUBMIT_PATH, json=payload)

    assert response.status_code == 401
    body = response.json()
    assert body["requestId"] == "unknown"
    assert body["formId"] == "single-field-update"
    assert body["errors"][0]["code"] == "UNAUTHENTICATED"
    assert authorizer.calls == 0
    assert service.submissions == []


def test_generic_error_uses_shared_error_envelope(tmp_path: Path) -> None:
    class ExplodingRegistry:
        def get(self, _form_id: str):
            raise RuntimeError("storage details must not leak")

    components = _components(tmp_path, forms=ExplodingRegistry())
    with TestClient(components.app) as client:
        response = client.post(SUBMIT_PATH, json=_payload(), headers=_headers())

    assert response.status_code == 500
    parsed = FormSubmitErrorV1.model_validate(response.json())
    assert parsed.errors[0].code == "INTERNAL_ERROR"
    assert "storage" not in parsed.errors[0].message.lower()


def test_same_key_replays_and_different_payload_conflicts(tmp_path: Path) -> None:
    components = _components(tmp_path)
    with TestClient(components.app) as client:
        first = client.post(SUBMIT_PATH, json=_payload(), headers=_headers())
        replay = client.post(
            SUBMIT_PATH,
            json=_payload(request_id="request-retry"),
            headers=_headers(),
        )
        conflict = client.post(
            SUBMIT_PATH,
            json=_payload(phone="13900139000"),
            headers=_headers(),
        )

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json()["result"] == first.json()["result"]
    assert conflict.status_code == 409
    assert FormSubmitErrorV1.model_validate(conflict.json()).errors[0].code == "IDEMPOTENCY_KEY_CONFLICT"
    assert components.repository.count_submissions() == 1


def test_submission_audit_log_has_safe_versioned_correlation(tmp_path: Path, caplog) -> None:
    components = _components(tmp_path)
    with caplog.at_level(logging.INFO, logger="agent_core.a2ui.audit"):
        with TestClient(components.app) as client:
            response = client.post(SUBMIT_PATH, json=_payload(), headers=_headers())

    assert response.status_code == 200
    events = [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == "agent_core.a2ui.audit"
    ]
    completed = next(event for event in events if event["event"] == "submission_completed")
    assert completed == {
        "event": "submission_completed",
        "requestId": "request-001",
        "formId": "single-field-update",
        "schemaVersion": "1.0.0",
        "revision": 1,
        "subjectId": "user-a",
        "tenantId": "tenant-a",
        "submissionId": response.json()["result"]["submissionId"],
        "resultCode": "SUCCESS",
    }
    rendered = "\n".join(record.getMessage() for record in caplog.records)
    assert "13800138000" not in rendered
    assert "idem-001" not in rendered
    assert "writer" not in rendered


def test_replay_precedes_current_revision_validation(tmp_path: Path) -> None:
    components = _components(tmp_path)
    with TestClient(components.app) as client:
        first = client.post(SUBMIT_PATH, json=_payload(), headers=_headers())
        revised = copy.deepcopy(_single_field_document())
        revised["revision"] = 2
        components.registry.replace(build_form_snapshot(revised))
        replay = client.post(
            SUBMIT_PATH,
            json=_payload(request_id="request-retry"),
            headers=_headers(),
        )

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json()["result"]["submissionId"] == first.json()["result"]["submissionId"]


def test_401_and_403_use_host_port_boundary_and_no_store(tmp_path: Path) -> None:
    components = _components(tmp_path)
    with TestClient(components.app) as client:
        unauthenticated = client.post(SUBMIT_PATH, json={"not": "a valid request"})
        forbidden = client.post(SUBMIT_PATH, json=_payload(), headers=_headers("blocked"))

    assert unauthenticated.status_code == 401
    assert FormSubmitErrorV1.model_validate(unauthenticated.json()).errors[0].code == "UNAUTHENTICATED"
    assert unauthenticated.headers["cache-control"] == "no-store"
    assert forbidden.status_code == 403
    assert FormSubmitErrorV1.model_validate(forbidden.json()).errors[0].code == "FORBIDDEN"
    assert forbidden.headers["cache-control"] == "no-store"
    assert "www-authenticate" not in forbidden.headers
    assert components.repository.count_submissions() == 0


def test_owner_isolation_and_authorized_read_gate(tmp_path: Path) -> None:
    components = _components(tmp_path)
    with TestClient(components.app) as client:
        created = client.post(SUBMIT_PATH, json=_payload(), headers=_headers())
        submission_id = created.json()["result"]["submissionId"]
        foreign = client.get(f"/api/a2ui/v1/submissions/{submission_id}", headers=_headers("other"))
        components.authorizer.denied_subjects.add("user-a")
        revoked = client.get(f"/api/a2ui/v1/submissions/{submission_id}", headers=_headers())

    assert foreign.status_code == 404
    assert revoked.status_code == 403
    assert revoked.headers["cache-control"] == "no-store"


def test_audit_read_failure_fails_closed_with_safe_json_error_and_log(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    components = _components(tmp_path)
    with TestClient(components.app) as client:
        created = client.post(SUBMIT_PATH, json=_payload(), headers=_headers())
    submission_id = created.json()["result"]["submissionId"]
    secret = "audit-port-secret-13800138000"

    def fail_audit_read(*, principal, response) -> None:
        del principal, response
        raise RuntimeError(secret)

    monkeypatch.setattr(components.service, "audit_read", fail_audit_read)
    caplog.clear()
    with caplog.at_level(logging.ERROR, logger="agent_core.a2ui_submission.http"):
        with TestClient(components.app) as client:
            read = client.get(f"/api/a2ui/v1/submissions/{submission_id}", headers=_headers())

    assert read.status_code == 500
    assert read.headers["content-type"].startswith("application/json")
    error = FormSubmitErrorV1.model_validate(read.json())
    assert error.status == "error"
    assert error.request_id == "unknown"
    assert error.form_id == "unknown"
    assert error.errors[0].code == "INTERNAL_ERROR"
    assert error.errors[0].retryable is True
    assert secret not in read.text
    assert secret not in caplog.text
    assert "A2UI submission read audit failed" in caplog.text


def test_concurrent_same_key_creates_one_submission(tmp_path: Path) -> None:
    components = _components(tmp_path)
    command = validate_form_submit_request(_payload())
    principal = AuthenticatedPrincipal(subject_id="user-a", tenant_id="tenant-a")

    def submit_once():
        return components.service.submit(
            principal=principal,
            form_id_from_path="single-field-update",
            command=command,
        )

    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(executor.map(lambda _item: submit_once(), range(8)))

    assert components.repository.count_submissions() == 1
    assert {response.body["result"]["submissionId"] for response in responses}.__len__() == 1


def test_migrations_are_repeatable_and_restart_keeps_data_readable(tmp_path: Path) -> None:
    components = _components(tmp_path)
    components.repository.migrate()
    assert components.repository.applied_migrations() == ["0001_a2ui_form_submissions"]

    with TestClient(components.app) as client:
        created = client.post(SUBMIT_PATH, json=_payload(), headers=_headers())
        submission_id = created.json()["result"]["submissionId"]

    restarted_repository = SQLiteSubmissionRepository(components.database_url)
    restarted_repository.migrate()
    restarted_service = SubmissionService(repository=restarted_repository, forms=components.registry)
    restarted_app = _compose_app(
        service=restarted_service,
        provider=components.provider,
        authorizer=components.authorizer,
        document=components.document,
    )
    with TestClient(restarted_app) as client:
        read = client.get(f"/api/a2ui/v1/submissions/{submission_id}", headers=_headers())

    assert read.status_code == 200
    assert read.json()["submissionId"] == submission_id


def test_registry_accepts_only_the_shared_profile_model(tmp_path: Path) -> None:
    del tmp_path
    malformed = copy.deepcopy(_single_field_document())
    malformed["schemaVersion"] = "2.0.0"

    with pytest.raises(ProtocolValidationError):
        InMemoryFormRegistry.from_documents([malformed])


def test_public_type_annotations_resolve_without_name_error() -> None:
    """``typing.get_type_hints`` must resolve all module-level public
    callables without raising ``NameError``, as required by port contracts."""
    import typing

    import agent_core.a2ui_submission.forms as mod

    for name in ("validate_submission_data", "_validate_file_references"):
        target = getattr(mod, name)
        # get_type_hints raises NameError if any annotation references
        # an undefined name (issue: undefined ``Principal``).
        hints = typing.get_type_hints(target)
        assert "principal" in hints

    # ``FileReferenceVerifier`` / ``RemoteOptionVerifier`` are ``Callable``
    # type aliases — ``get_type_hints`` does not apply to them, but their
    # annotations were verified indirectly via ``validate_submission_data``
    # and ``_validate_file_references`` whose signatures consume them.
