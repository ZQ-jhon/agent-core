from __future__ import annotations

import copy
import importlib
import json
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
from agent_core.a2ui_submission.forms import InMemoryFormRegistry, build_form_snapshot
from agent_core.a2ui_submission.http import create_submission_router
from agent_core.a2ui_submission.repository import SQLiteSubmissionRepository
from agent_core.a2ui_submission.service import SubmissionService


ROOT = Path(__file__).resolve().parents[1]
EXAMPLES_PATH = ROOT / "docs/a2ui/v1/form-examples-v1.json"
SUBMIT_PATH = "/api/a2ui/v1/forms/single-field-update/submissions"


def _single_field_document() -> dict:
    examples = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))["examples"]
    return next(example for example in examples if example["formId"] == "single-field-update")


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

    def __call__(self, principal, form_key, _untrusted_context):
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
