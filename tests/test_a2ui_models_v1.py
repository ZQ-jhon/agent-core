from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from agent_core.a2ui import (
    A2UI_FORM_SCHEMA_VERSION,
    A2UIFormDocumentV1,
    DatePickerProps,
    FormResolveRequestV1,
    FormSubmitRequestV1,
    PatternValidator,
    ProtocolErrorCode,
    ProtocolValidationError,
    ValidationError,
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


# ── Strict date / RFC 3339 / RE2 pattern validation ────────────────────────


@pytest.mark.parametrize(
    ("valid_date",),
    [
        ("2026-01-01",),
        ("2026-07-27",),
        ("2026-12-31",),
        ("2024-02-29",),  # leap year
    ],
)
def test_datepicker_accepts_strict_yyyymmdd(valid_date: str) -> None:
    """DatePicker minDate / maxDate accept only strict YYYY-MM-DD."""
    DatePickerProps.model_validate({
        "label": "test",
        "minDate": valid_date,
        "maxDate": "2027-01-01",
    })


@pytest.mark.parametrize(
    ("invalid_date",),
    [
        ("20260727",),       # basic date – no dashes
        ("27-07-2026",),     # DD-MM-YYYY
        ("2026-07-27 00:00:00",),  # date-time instead of date
        ("2026/07/27",),     # wrong separator
        ("2026-7-27",),      # missing leading zero
        ("2026-13-01",),     # invalid month
        ("2026-02-30",),     # invalid day
        ("",),               # empty
    ],
)
def test_datepicker_rejects_non_iso_date(invalid_date: str) -> None:
    """DatePicker rejects values outside strict YYYY-MM-DD."""
    with pytest.raises(ValidationError):
        DatePickerProps.model_validate({
            "label": "test",
            "minDate": invalid_date,
        })


@pytest.mark.parametrize(
    ("valid_ts",),
    [
        ("2026-07-25T10:00:00Z",),
        ("2026-07-25T10:00:00+08:00",),
        ("2026-07-25t10:00:00z",),  # lower-case T/Z
        ("2026-07-25T10:00:00.123456Z",),  # fractional seconds
        ("2026-01-01T00:00:00+00:00",),
    ],
)
def test_rfc3339_accepts_strict_timestamps(valid_ts: str) -> None:
    """generatedAt / expiresAt accept strict RFC 3339 timestamps."""
    document = deepcopy(_examples()[0])
    document["generatedAt"] = valid_ts
    parsed = validate_form_document(document)
    assert parsed.generated_at == valid_ts


@pytest.mark.parametrize(
    ("invalid_ts",),
    [
        ("2026-07-27 10:00:00+00:00",),  # space separator
        ("2026-07-27 10:00:00Z",),        # space + Z
        ("20260727T10:00:00Z",),           # basic date
        ("2026-07-27",),                   # date only, no time
        ("2026-07-27T10:00:00",),          # no offset
        ("2026-07-27T10:00:00+0000",),     # offset without colon
        ("2026-07-27T10:00:00+00",),       # truncated offset
        ("2026-07-27T10:00:00 UTC",),      # non-standard offset
    ],
)
def test_rfc3339_rejects_lenient_timestamps(invalid_ts: str) -> None:
    """generatedAt rejects RFC 3339 non-conformant timestamps."""
    document = deepcopy(_examples()[0])
    document["generatedAt"] = invalid_ts
    assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_INVALID


@pytest.mark.parametrize(
    ("valid_pattern",),
    [
        (r"^1[3-9][0-9]{9}$",),
        (r"[a-z]+",),
        (r"\\d{3}-\\d{4}",),
        (r"a|b",),
        (r"(?:foo|bar)",),   # non-capturing group is RE2-safe
        (r"[a-z&&[^aeiou]]",),  # character class intersection is RE2-safe
    ],
)
def test_pattern_accepts_re2_compatible(valid_pattern: str) -> None:
    """PatternValidator accepts RE2-compatible patterns."""
    PatternValidator.model_validate({"type": "pattern", "value": valid_pattern})


@pytest.mark.parametrize(
    ("invalid_pattern",),
    [
        ("(?<=prefix)",),       # lookbehind
        ("(?=suffix)",),        # lookahead
        ("(?!suffix)",),        # negative lookahead
        ("(?<!prefix)",),       # negative lookbehind
        ("(?>atomic)",),        # atomic group
        (r"(a)\1",),            # backreference
        (r"(?P<name>a)(?P=name)",),  # named backreference
        (r"\k<name>",),         # named backreference (\k<)
        ("(?R)",),              # recursion
        ("(?&name)",),          # subroutine call
        ("(?()|)",),            # conditional
        ("a*+",),               # possessive quantifier *+
        ("a++",),               # possessive quantifier ++
        ("a?+",),               # possessive quantifier ?+
        ("a{1,2}+",),           # possessive quantifier {}+ 
        ("a{3}+",),             # possessive quantifier exact {}+
    ],
)
def test_pattern_rejects_non_re2(invalid_pattern: str) -> None:
    """PatternValidator rejects patterns using RE2-incompatible features."""
    with pytest.raises(ValidationError):
        PatternValidator.model_validate({"type": "pattern", "value": invalid_pattern})


def test_datepicker_in_validate_form_document_rejects_basic_date() -> None:
    """A document with a DatePicker using basic-date value is rejected."""
    document = {
        "schemaVersion": "1.0.0",
        "requestId": "req-date-test",
        "formId": "date-test-form",
        "revision": 1,
        "root": {
            "id": "date-form",
            "type": "Form",
            "props": {"title": "Date Test"},
            "children": [
                {
                    "id": "date-picker",
                    "type": "DatePicker",
                    "props": {
                        "label": "Select date",
                        "minDate": "20260727"
                    },
                    "children": [],
                    "dataPath": "/selectedDate"
                },
                {
                    "id": "submit-btn",
                    "type": "Button",
                    "props": {"label": "Submit", "variant": "primary"},
                    "children": [],
                    "action": {"actionId": "do-submit"}
                }
            ]
        },
        "data": {"initialValues": {"selectedDate": "2026-07-27"}},
        "actions": [{"id": "do-submit", "type": "submit", "endpointKey": "test.submit", "method": "POST"}]
    }
    assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_INVALID


def test_datepicker_data_binding_rejects_basic_date() -> None:
    """DatePicker initial value using basic-date format triggers DATA_BINDING_INVALID."""
    document = {
        "schemaVersion": "1.0.0",
        "requestId": "req-date-db",
        "formId": "date-db-form",
        "revision": 1,
        "root": {
            "id": "db-form",
            "type": "Form",
            "props": {"title": "Date DB Test"},
            "children": [
                {
                    "id": "db-date",
                    "type": "DatePicker",
                    "props": {"label": "Pick date"},
                    "children": [],
                    "dataPath": "/selectedDate"
                },
                {
                    "id": "db-submit",
                    "type": "Button",
                    "props": {"label": "Go", "variant": "primary"},
                    "children": [],
                    "action": {"actionId": "go"}
                }
            ]
        },
        "data": {"initialValues": {"selectedDate": "20260727"}},
        "actions": [{"id": "go", "type": "submit", "endpointKey": "test.go", "method": "POST"}]
    }
    assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID


def test_datepicker_initial_value_rejects_basic_date() -> None:
    """DatePicker initial value using basic-date format triggers DATA_BINDING_INVALID."""
    document = deepcopy(_examples()[1])  # conditional-application has a DatePicker
    # Set the DatePicker's initial value to a basic date (no dashes)
    document["data"]["initialValues"]["access"] = {"startDate": "20260727", "level": None}
    assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID


def test_document_timestamp_semantic_check_still_validates_order() -> None:
    """Expires before generated is still rejected after strict parsing."""
    document = deepcopy(_examples()[0])
    document["generatedAt"] = "2026-07-25T10:00:00Z"
    document["expiresAt"] = "2026-07-24T10:00:00Z"
    assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID
