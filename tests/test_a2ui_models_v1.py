from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from agent_core.a2ui import (
    A2UI_FORM_SCHEMA_VERSION,
    FormResolveRequestV1,
    FormSubmitRequestV1,
    ProtocolErrorCode,
    ProtocolValidationError,
    validate_api_message,
    validate_form_document,
    validate_form_resolve_request,
    validate_form_submit_request,
)


ROOT = Path(__file__).resolve().parents[1]
EXAMPLES_PATH = ROOT / "docs/a2ui/v1/form-examples-v1.json"


def _examples() -> list[dict[str, Any]]:
    return json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))["examples"]


def _walk_nodes(node: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield node
    for child in node["children"]:
        yield from _walk_nodes(child)


def _node(document: dict[str, Any], component_type: str) -> dict[str, Any]:
    return next(
        node for node in _walk_nodes(document["root"]) if node["type"] == component_type
    )


def _error_code(call: Callable[[], object]) -> ProtocolErrorCode:
    with pytest.raises(ProtocolValidationError) as raised:
        call()
    return raised.value.code


def test_frozen_v1_fixtures_parse_and_round_trip() -> None:
    """The three approved documents are the legal fixture bundle for v1."""

    expected_ids = {
        "single-field-update",
        "conditional-application",
        "remote-options-application",
    }
    examples = _examples()
    assert {example["formId"] for example in examples} == expected_ids

    for example in examples:
        document = validate_form_document(example)
        assert document.schema_version == A2UI_FORM_SCHEMA_VERSION
        assert document.form_id == example["formId"]
        # A dump may materialize documented defaults, but it remains a legal v1 document.
        reparsed = validate_form_document(
            document.model_dump(by_alias=True, exclude_unset=True)
        )
        assert reparsed.form_id == document.form_id


def test_submit_envelope_and_all_api_response_shapes_parse() -> None:
    submit = {
        "schemaVersion": "1.0.0",
        "requestId": "req-submit-001",
        "idempotencyKey": "idem-submit-01J2ABC",
        "formId": "travel-application",
        "revision": 4,
        "action": {
            "actionId": "submit-trip",
            "sourceComponentId": "trip-submit-button",
        },
        "data": {"destination": {"countryCode": "CN", "cityId": "sha"}},
        "client": {"locale": "zh-CN", "timeZone": "Asia/Shanghai"},
    }
    parsed_submit = validate_form_submit_request(submit)
    assert isinstance(parsed_submit, FormSubmitRequestV1)

    resolve = {
        "schemaVersion": "1.0.0",
        "requestId": "req-resolve-001",
        "formKey": "travel-application",
        "context": {"conversationId": "untrusted-conv"},
        "client": {
            "supportedSchemaVersions": ["1.0.0"],
            "supportedComponents": ["Form", "Section", "TextInput", "Button"],
        },
    }
    assert isinstance(validate_form_resolve_request(resolve), FormResolveRequestV1)

    response_messages = [
        {
            "schemaVersion": "1.0.0",
            "requestId": "req-resolve-001",
            "formKey": "travel-application",
            "status": "error",
            "errors": [
                {
                    "code": "CLIENT_CAPABILITY_MISMATCH",
                    "message": "Client capability is insufficient.",
                    "retryable": False,
                }
            ],
        },
        {
            "schemaVersion": "1.0.0",
            "requestId": "req-submit-001",
            "formId": "travel-application",
            "status": "success",
            "result": {"submissionId": "submission-01J2ABC"},
        },
        {
            "schemaVersion": "1.0.0",
            "requestId": "req-submit-001",
            "formId": "travel-application",
            "status": "validation_error",
            "fieldErrors": {
                "/destination/cityId": [
                    {
                        "code": "CITY_NOT_AVAILABLE",
                        "message": "The selected city is unavailable.",
                        "componentId": "remote-city",
                    }
                ]
            },
            "errors": [],
        },
        {
            "schemaVersion": "1.0.0",
            "requestId": "req-submit-001",
            "formId": "travel-application",
            "status": "error",
            "errors": [
                {
                    "code": "FORM_REVISION_CONFLICT",
                    "message": "The form has changed.",
                    "retryable": True,
                }
            ],
        },
    ]
    for message in response_messages:
        assert validate_api_message(message).schema_version == "1.0.0"


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (
            lambda document: document.__setitem__("schemaVersion", "1.0.1"),
            ProtocolErrorCode.SCHEMA_VERSION_UNSUPPORTED,
        ),
        (
            lambda document: _node(document, "TextInput").__setitem__("type", "ScriptInput"),
            ProtocolErrorCode.COMPONENT_UNSUPPORTED,
        ),
        (
            lambda document: _node(document, "TextInput")["props"].__setitem__(
                "expression", "__import__('os').system('not-run')"
            ),
            ProtocolErrorCode.SCHEMA_INVALID,
        ),
        (
            lambda document: document["root"].update(
                {"type": "Section", "props": {"title": "Wrong root"}}
            ),
            ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID,
        ),
        (
            lambda document: _node(document, "TextInput").__setitem__(
                "id", document["root"]["id"]
            ),
            ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID,
        ),
        (
            lambda document: _node(document, "Button")["action"].__setitem__(
                "actionId", "missing-action"
            ),
            ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID,
        ),
        (
            lambda document: _node(document, "TextInput").__setitem__(
                "dataPath", "/missing-value"
            ),
            ProtocolErrorCode.DATA_BINDING_INVALID,
        ),
    ],
)
def test_rejection_paths_are_stable(
    mutate: Callable[[dict[str, Any]], None], expected: ProtocolErrorCode
) -> None:
    document = deepcopy(_examples()[0])
    mutate(document)
    assert _error_code(lambda: validate_form_document(document)) == expected


@pytest.mark.parametrize(
    ("target", "field", "value"),
    [
        ("props", "script", "<script>never execute</script>"),
        ("action", "url", "https://untrusted.invalid/execute"),
        ("data_source", "query", {"unsafe": "configuration"}),
        ("data_source", "headers", {"Authorization": "secret"}),
    ],
)
def test_executable_or_transport_configuration_is_rejected(
    target: str, field: str, value: Any
) -> None:
    document = deepcopy(_examples()[2])
    if target == "props":
        _node(document, "Select")["props"][field] = value
    elif target == "action":
        _node(document, "Button")["action"][field] = value
    else:
        document["dataSources"][0][field] = value

    with pytest.raises(ProtocolValidationError) as raised:
        validate_form_document(document)

    assert raised.value.code == ProtocolErrorCode.SCHEMA_INVALID
    assert str(value) not in str(raised.value)


def test_pattern_rules_reject_non_re2_features_without_compiling_them() -> None:
    document = deepcopy(_examples()[0])
    _node(document, "TextInput")["validation"] = [
        {"type": "pattern", "value": "(?<=prefix)unsafe"}
    ]
    assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_INVALID


def test_resolve_context_is_untrusted_json_not_terminal_identity() -> None:
    request = {
        "schemaVersion": "1.0.0",
        "requestId": "req-resolve-identity",
        "formKey": "travel-application",
        "context": {
            "principal": "claimed-user",
            "providerApiKey": "untrusted-model-key",
        },
        "client": {
            "supportedSchemaVersions": ["1.0.0"],
            "supportedComponents": ["Form"],
        },
    }
    parsed = validate_form_resolve_request(request)
    assert parsed.context == request["context"]
    assert not hasattr(parsed, "principal")

    request["principal"] = "attempted-terminal-identity"
    assert _error_code(lambda: validate_form_resolve_request(request)) == ProtocolErrorCode.SCHEMA_INVALID
