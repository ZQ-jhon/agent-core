from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from agent_core.a2ui import (
    A2UI_FORM_SCHEMA_VERSION,
    DatePickerProps,
    FormResolveRequestV1,
    FormSubmitRequestV1,
    PatternValidator,
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


# ── Strict date / RFC 3339 / RE2 pattern validation (ISSUE-58) ──────────────


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
        ("",),               # empty string
    ],
)
def test_datepicker_rejects_non_iso_date(invalid_date: str) -> None:
    """DatePicker rejects non-ISO-8601 YYYY-MM-DD dates."""
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
        ("2026-07-25t10:00:00z",),  # lowercase z/t accepted by RFC 3339
        ("2026-07-25T10:00:00.123456Z",),  # fractional seconds
        ("2026-01-01T00:00:00+00:00",),
    ],
)
def test_rfc3339_accepts_strict_timestamps(valid_ts: str) -> None:
    """generatedAt/expiresAt accept only strict RFC 3339 timestamps."""
    document = deepcopy(_examples()[0])
    document["generatedAt"] = valid_ts
    document["expiresAt"] = "2027-01-01T00:00:00Z"
    validate_form_document(document)


@pytest.mark.parametrize(
    ("invalid_ts",),
    [
        ("2026-07-27 10:00:00+00:00",),   # space separator instead of T
        ("2026-07-27 10:00:00Z",),         # space separator
        ("20260727T10:00:00Z",),            # basic date (no dashes)
        ("2026-07-27",),                    # date-only, no time
        ("2026-07-27T10:00:00",),           # missing offset
        ("2026-07-27T10:00:00+0000",),      # offset without colon
        ("2026-07-27T10:00:00+00",),        # offset hour-only
        ("2026-07-27T10:00:00 UTC",),       # named zone instead of offset
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
        # Character class escaping: escaped ] inside brackets must be RE2-safe.
        (r"[\\]]",),           # character class containing literal backslash and ]
        (r"[\\]]+",),         # escaped-] + quantifier — must not trigger possessive detection
        (r"[a-z\\]]",),        # range + escaped ]
        (r"[-\\]]",),          # leading hyphen + escaped ]
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
        (r"(?P<name>a)",),      # named capture definition (standalone)
        (r"(?P<name>a)(?P=name)",),  # named capture + backreference
        (r"\k<name>",),         # named backreference (\k<)
        (r"\k'name'",),         # named backreference (\k')
        ("(?R)",),              # recursion
        ("(?&name)",),          # subroutine call
        ("(?()|)",),            # conditional
        ("a*+",),               # possessive quantifier *+
        ("a++",),               # possessive quantifier ++
        ("a?+",),               # possessive quantifier ?+
        ("a{1,2}+",),           # possessive quantifier {}+
        ("a{3}+",),             # possessive quantifier exact {}+
        ("[a-z]++",),           # possessive quantifier after character class (outside)
    ],
)
def test_pattern_rejects_non_re2(invalid_pattern: str) -> None:
    """PatternValidator rejects patterns using RE2-incompatible features."""
    with pytest.raises(ValidationError):
        PatternValidator.model_validate({"type": "pattern", "value": invalid_pattern})


class TestRe2CharClassEscaping:
    """Character class escaping with \\] must not cause false-positive
    possessive-quantifier detection or spurious class closure."""

    @pytest.mark.parametrize(
        ("pattern", "should_accept"),
        [
            # Escaped ] inside character class (RE2-safe)
            (r"[\\]]", True),
            (r"[a-z\\]]", True),
            (r"[-\\]]", True),
            (r"[\\]a-z]", True),
            (r"[\\]]+", True),
            (r"[\\]]*", True),
            (r"[\\]]?", True),
            (r"[\\]]{1,3}", True),
            # Normal character classes (RE2-safe)
            (r"[a-z]", True),
            (r"[0-9]+", True),
            (r"[^aeiou]", True),
            # Possessive quantifier after char class (non-RE2)
            (r"[a-z]++", False),
            (r"[a-z]*+", False),
            (r"[a-z]?+", False),
            (r"[a-z]{2}+", False),
        ],
    )
    def test_char_class_escaping_boundaries(
        self, pattern: str, should_accept: bool
    ) -> None:
        if should_accept:
            PatternValidator.model_validate(
                {"type": "pattern", "value": pattern}
            )
        else:
            with pytest.raises(ValidationError):
                PatternValidator.model_validate(
                    {"type": "pattern", "value": pattern}
                )


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


# ---------------------------------------------------------------------------
# Regression: setValue type validation (ISSUE-57)
# ---------------------------------------------------------------------------


def _base_conditional_document(
    *,
    input_type: str,
    data_path: str,
    initial_value: Any,
    extra_props: dict[str, Any] | None = None,
    target_data_path: str,
    set_value_value: Any,
    then_branch: bool = True,
) -> dict[str, Any]:
    """Build a minimal conditional document with one input and one setValue rule.

    The rule fires from a separate trigger path to avoid self-loop cycles.
    """
    props: dict[str, Any] = {"label": "Test Field"}
    if extra_props:
        props.update(extra_props)

    effects = [{
        "type": "setValue",
        "targetDataPath": target_data_path,
        "value": set_value_value,
    }]
    # then must have at least 1 effect (min_length=1 on LinkRule.then).
    dummy_then = [{
        "type": "setVisible",
        "targetComponentId": "submit-btn",
        "value": True,
    }]

    trigger_path = "/trigger/source"
    initial = _path_to_nested(data_path, initial_value)
    # Also add the trigger path so it exists.
    trigger_nested = _path_to_nested(trigger_path, "ready")
    _deep_merge(initial, trigger_nested)

    return {
        "schemaVersion": "1.0.0",
        "requestId": "req-setvalue-test",
        "formId": "setvalue-test",
        "revision": 1,
        "generatedAt": "2026-07-26T00:00:00Z",
        "root": {
            "id": "form",
            "type": "Form",
            "props": {"title": "setValue Type Test"},
            "children": [
                {
                    "id": "section",
                    "type": "Section",
                    "props": {"title": "Input Section"},
                    "children": [
                        {
                            "id": "input-field",
                            "type": input_type,
                            "props": props,
                            "children": [],
                            "dataPath": data_path,
                        },
                    ],
                },
                {
                    "id": "submit-btn",
                    "type": "Button",
                    "props": {"label": "Submit", "variant": "primary"},
                    "children": [],
                    "action": {"actionId": "submit-action"},
                },
            ],
        },
        "data": {"initialValues": initial},
        "actions": [
            {"id": "submit-action", "type": "submit", "endpointKey": "forms.submit", "method": "POST"},
        ],
        "rules": [
            {
                "id": "setvalue-rule",
                "event": "change",
                "sourceDataPath": trigger_path,
                "when": {"op": "equals", "path": trigger_path, "value": "ready"},
                "then" if then_branch else "else": effects if then_branch else dummy_then,
                "else" if then_branch else "then": [] if then_branch else effects,
            },
        ],
        "meta": {"locale": "zh-CN", "title": "setValue Type Test"},
    }


def _path_to_nested(path: str, value: Any) -> dict[str, Any]:
    """Convert /a/b → {"a": {"b": value}}."""
    parts = path.removeprefix("/").split("/")
    result: dict[str, Any] = {}
    current = result
    for part in parts[:-1]:
        current[part] = {}
        current = current[part]
    current[parts[-1]] = value
    return result


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> None:
    """Merge overlay into base in-place."""
    for key, value in overlay.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value


class TestSetValueTypeValidation:
    """setValue then/else values must match the bound component's type."""

    # --- TextInput (string value) ---

    def test_textinput_setvalue_accepts_string_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="TextInput",
            data_path="/field/name",
            initial_value="hello",
            target_data_path="/field/name",
            set_value_value="new-value",
            then_branch=True,
        )
        validate_form_document(document)

    def test_textinput_setvalue_accepts_string_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="TextInput",
            data_path="/field/name",
            initial_value="hello",
            target_data_path="/field/name",
            set_value_value="fallback",
            then_branch=False,
        )
        validate_form_document(document)

    def test_textinput_setvalue_rejects_integer_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="TextInput",
            data_path="/field/name",
            initial_value="hello",
            target_data_path="/field/name",
            set_value_value=123,
            then_branch=True,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    def test_textinput_setvalue_rejects_integer_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="TextInput",
            data_path="/field/name",
            initial_value="hello",
            target_data_path="/field/name",
            set_value_value=456,
            then_branch=False,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    # --- NumberInput (number value) ---

    def test_numberinput_setvalue_accepts_number_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="NumberInput",
            data_path="/field/count",
            initial_value=1,
            target_data_path="/field/count",
            set_value_value=42,
            then_branch=True,
        )
        validate_form_document(document)

    def test_numberinput_setvalue_accepts_number_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="NumberInput",
            data_path="/field/count",
            initial_value=1,
            target_data_path="/field/count",
            set_value_value=0,
            then_branch=False,
        )
        validate_form_document(document)

    def test_numberinput_setvalue_rejects_string_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="NumberInput",
            data_path="/field/count",
            initial_value=1,
            target_data_path="/field/count",
            set_value_value="not-a-number",
            then_branch=True,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    def test_numberinput_setvalue_rejects_string_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="NumberInput",
            data_path="/field/count",
            initial_value=1,
            target_data_path="/field/count",
            set_value_value="bad",
            then_branch=False,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    # --- Select (scalar value from options) ---

    def test_select_setvalue_accepts_valid_option_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="Select",
            data_path="/field/choice",
            initial_value="read",
            extra_props={"options": [{"label": "Read", "value": "read"}, {"label": "Write", "value": "write"}]},
            target_data_path="/field/choice",
            set_value_value="write",
            then_branch=True,
        )
        validate_form_document(document)

    def test_select_setvalue_accepts_valid_option_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="Select",
            data_path="/field/choice",
            initial_value="write",
            extra_props={"options": [{"label": "Read", "value": "read"}, {"label": "Write", "value": "write"}]},
            target_data_path="/field/choice",
            set_value_value="read",
            then_branch=False,
        )
        validate_form_document(document)

    def test_select_setvalue_rejects_list_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="Select",
            data_path="/field/choice",
            initial_value="read",
            extra_props={"options": [{"label": "Read", "value": "read"}]},
            target_data_path="/field/choice",
            set_value_value=["read"],
            then_branch=True,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    def test_select_setvalue_rejects_value_not_in_options_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="Select",
            data_path="/field/choice",
            initial_value="read",
            extra_props={"options": [{"label": "Read", "value": "read"}]},
            target_data_path="/field/choice",
            set_value_value="unknown-option",
            then_branch=False,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    # --- CheckboxGroup (list of scalar values) ---

    def test_checkboxgroup_setvalue_accepts_list_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="CheckboxGroup",
            data_path="/field/tags",
            initial_value=[],
            extra_props={"options": [{"label": "A", "value": "a"}, {"label": "B", "value": "b"}]},
            target_data_path="/field/tags",
            set_value_value=["a", "b"],
            then_branch=True,
        )
        validate_form_document(document)

    def test_checkboxgroup_setvalue_accepts_list_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="CheckboxGroup",
            data_path="/field/tags",
            initial_value=["a"],
            extra_props={"options": [{"label": "A", "value": "a"}, {"label": "B", "value": "b"}]},
            target_data_path="/field/tags",
            set_value_value=[],
            then_branch=False,
        )
        validate_form_document(document)

    def test_checkboxgroup_setvalue_rejects_string_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="CheckboxGroup",
            data_path="/field/tags",
            initial_value=[],
            extra_props={"options": [{"label": "A", "value": "a"}]},
            target_data_path="/field/tags",
            set_value_value="not-a-list",
            then_branch=True,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    def test_checkboxgroup_setvalue_rejects_non_option_value_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="CheckboxGroup",
            data_path="/field/tags",
            initial_value=[],
            extra_props={"options": [{"label": "A", "value": "a"}]},
            target_data_path="/field/tags",
            set_value_value=["unknown"],
            then_branch=False,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    # --- Upload (list of upload objects) ---

    def test_upload_setvalue_accepts_valid_upload_list_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="Upload",
            data_path="/field/files",
            initial_value=[],
            extra_props={"buttonLabel": "Upload"},
            target_data_path="/field/files",
            set_value_value=[{"fileId": "f1", "name": "doc.pdf", "size": 1024, "mimeType": "application/pdf", "status": "uploaded"}],
            then_branch=True,
        )
        # Upload needs an action binding on the input component, not just the submit button.
        document["root"]["children"][0]["children"][0]["action"] = {"actionId": "upload-action"}
        document["actions"].append({"id": "upload-action", "type": "upload", "endpointKey": "files.upload", "method": "POST"})
        validate_form_document(document)

    def test_upload_setvalue_rejects_string_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="Upload",
            data_path="/field/files",
            initial_value=[],
            extra_props={"buttonLabel": "Upload"},
            target_data_path="/field/files",
            set_value_value="not-a-list",
            then_branch=False,
        )
        document["root"]["children"][0]["children"][0]["action"] = {"actionId": "upload-action"}
        document["actions"].append({"id": "upload-action", "type": "upload", "endpointKey": "files.upload", "method": "POST"})
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    # --- Switch (boolean value) ---

    def test_switch_setvalue_accepts_bool_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="Switch",
            data_path="/field/flag",
            initial_value=False,
            target_data_path="/field/flag",
            set_value_value=True,
            then_branch=True,
        )
        validate_form_document(document)

    def test_switch_setvalue_rejects_string_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="Switch",
            data_path="/field/flag",
            initial_value=False,
            target_data_path="/field/flag",
            set_value_value="true",
            then_branch=False,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    # --- DatePicker (ISO date string) ---

    def test_datepicker_setvalue_accepts_iso_date_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="DatePicker",
            data_path="/field/date",
            initial_value="2026-07-26",
            target_data_path="/field/date",
            set_value_value="2026-08-01",
            then_branch=True,
        )
        validate_form_document(document)

    def test_datepicker_setvalue_rejects_non_date_string_in_else(self) -> None:
        document = _base_conditional_document(
            input_type="DatePicker",
            data_path="/field/date",
            initial_value="2026-07-26",
            target_data_path="/field/date",
            set_value_value="not-a-date",
            then_branch=False,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID

    # --- RadioGroup (scalar value from options) ---

    def test_radiogroup_setvalue_accepts_valid_option_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="RadioGroup",
            data_path="/field/opt",
            initial_value="a",
            extra_props={"options": [{"label": "A", "value": "a"}, {"label": "B", "value": "b"}]},
            target_data_path="/field/opt",
            set_value_value="b",
            then_branch=True,
        )
        validate_form_document(document)

    def test_radiogroup_setvalue_rejects_non_option_value_in_then(self) -> None:
        document = _base_conditional_document(
            input_type="RadioGroup",
            data_path="/field/opt",
            initial_value="a",
            extra_props={"options": [{"label": "A", "value": "a"}]},
            target_data_path="/field/opt",
            set_value_value="c",
            then_branch=True,
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.DATA_BINDING_INVALID


# ---------------------------------------------------------------------------
# Regression: validator type compatibility (ISSUE-57)
# ---------------------------------------------------------------------------


class TestValidatorCompatibility:
    """Validators must be compatible with the component's value type."""

    # --- Helpers ---

    @staticmethod
    def _document_with_validation(
        component_type: str,
        data_path: str,
        initial_value: Any,
        validation: list[dict[str, Any]],
        extra_props: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build a minimal document with one input carrying the given validators."""
        props: dict[str, Any] = {"label": "Test"}
        if extra_props:
            props.update(extra_props)

        return {
            "schemaVersion": "1.0.0",
            "requestId": "req-validator-test",
            "formId": "validator-test",
            "revision": 1,
            "generatedAt": "2026-07-26T00:00:00Z",
            "root": {
                "id": "form",
                "type": "Form",
                "props": {"title": "Validator Test"},
                "children": [
                    {
                        "id": "input-field",
                        "type": component_type,
                        "props": props,
                        "children": [],
                        "dataPath": data_path,
                        "validation": validation,
                    },
                    {
                        "id": "submit-btn",
                        "type": "Button",
                        "props": {"label": "Submit", "variant": "primary"},
                        "children": [],
                        "action": {"actionId": "submit-action"},
                    },
                ],
            },
            "data": {"initialValues": _path_to_nested(data_path, initial_value)},
            "actions": [
                {"id": "submit-action", "type": "submit", "endpointKey": "forms.submit", "method": "POST"},
            ],
            "meta": {"locale": "zh-CN"},
        }

    # --- Compatible pairs (representative sample) ---

    def test_textinput_accepts_length_and_pattern_validators(self) -> None:
        document = self._document_with_validation(
            "TextInput", "/field/v", "hello",
            [
                {"type": "required", "message": "Required"},
                {"type": "minLength", "value": 1},
                {"type": "maxLength", "value": 100},
                {"type": "pattern", "value": "^[a-z]+$"},
            ],
        )
        validate_form_document(document)

    def test_numberinput_accepts_number_and_integer_validators(self) -> None:
        document = self._document_with_validation(
            "NumberInput", "/field/v", 1,
            [
                {"type": "required", "message": "Required"},
                {"type": "minimum", "value": 0},
                {"type": "maximum", "value": 100},
                {"type": "integer", "message": "Must be integer"},
            ],
        )
        validate_form_document(document)

    def test_checkboxgroup_accepts_items_and_required_validators(self) -> None:
        document = self._document_with_validation(
            "CheckboxGroup", "/field/v", [],
            [
                {"type": "required", "message": "Required"},
                {"type": "minItems", "value": 1},
                {"type": "maxItems", "value": 5},
            ],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        validate_form_document(document)

    def test_upload_accepts_items_and_required_validators(self) -> None:
        document = self._document_with_validation(
            "Upload", "/field/v", [],
            [
                {"type": "required", "message": "Required"},
                {"type": "maxItems", "value": 3},
            ],
            extra_props={"buttonLabel": "Upload"},
        )
        document["root"]["children"][0]["action"] = {"actionId": "upload-action"}
        document["actions"].append({"id": "upload-action", "type": "upload", "endpointKey": "files.upload", "method": "POST"})
        validate_form_document(document)

    def test_datepicker_accepts_length_and_required_validators(self) -> None:
        document = self._document_with_validation(
            "DatePicker", "/field/v", "2026-01-01",
            [
                {"type": "required", "message": "Required"},
                {"type": "minLength", "value": 10},
                {"type": "maxLength", "value": 10},
                {"type": "pattern", "value": "^[0-9-]+$"},
            ],
        )
        validate_form_document(document)

    def test_select_accepts_only_required_validator(self) -> None:
        # Select value type is statically ambiguous → only required allowed.
        document = self._document_with_validation(
            "Select", "/field/v", "a",
            [{"type": "required", "message": "Required"}],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        validate_form_document(document)

    def test_radiogroup_accepts_only_required_validator(self) -> None:
        document = self._document_with_validation(
            "RadioGroup", "/field/v", "a",
            [{"type": "required", "message": "Required"}],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        validate_form_document(document)

    # --- Incompatible pairs (representative sample) ---

    def test_numberinput_rejects_minlength(self) -> None:
        document = self._document_with_validation(
            "NumberInput", "/field/v", 1,
            [{"type": "minLength", "value": 1}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_numberinput_rejects_pattern(self) -> None:
        document = self._document_with_validation(
            "NumberInput", "/field/v", 1,
            [{"type": "pattern", "value": "^[0-9]+$"}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_numberinput_rejects_minitems(self) -> None:
        document = self._document_with_validation(
            "NumberInput", "/field/v", 1,
            [{"type": "minItems", "value": 1}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_textinput_rejects_minimum(self) -> None:
        document = self._document_with_validation(
            "TextInput", "/field/v", "hello",
            [{"type": "minimum", "value": 1}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_textinput_rejects_integer(self) -> None:
        document = self._document_with_validation(
            "TextInput", "/field/v", "hello",
            [{"type": "integer"}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_textinput_rejects_minitems(self) -> None:
        document = self._document_with_validation(
            "TextInput", "/field/v", "hello",
            [{"type": "minItems", "value": 1}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_checkboxgroup_rejects_minlength(self) -> None:
        document = self._document_with_validation(
            "CheckboxGroup", "/field/v", [],
            [{"type": "minLength", "value": 1}],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_checkboxgroup_rejects_minimum(self) -> None:
        document = self._document_with_validation(
            "CheckboxGroup", "/field/v", [],
            [{"type": "minimum", "value": 1}],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_checkboxgroup_rejects_pattern(self) -> None:
        document = self._document_with_validation(
            "CheckboxGroup", "/field/v", [],
            [{"type": "pattern", "value": "^[a-z]+$"}],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_select_rejects_pattern(self) -> None:
        # Select cannot statically guarantee a string value → reject pattern.
        document = self._document_with_validation(
            "Select", "/field/v", "a",
            [{"type": "pattern", "value": "^[a-z]+$"}],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_select_rejects_minlength(self) -> None:
        document = self._document_with_validation(
            "Select", "/field/v", "a",
            [{"type": "minLength", "value": 1}],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_select_rejects_minimum(self) -> None:
        document = self._document_with_validation(
            "Select", "/field/v", "a",
            [{"type": "minimum", "value": 1}],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_select_rejects_integer(self) -> None:
        document = self._document_with_validation(
            "Select", "/field/v", "a",
            [{"type": "integer"}],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_radiogroup_rejects_pattern(self) -> None:
        document = self._document_with_validation(
            "RadioGroup", "/field/v", "a",
            [{"type": "pattern", "value": "^[a-z]+$"}],
            extra_props={"options": [{"label": "A", "value": "a"}]},
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_datepicker_rejects_minimum(self) -> None:
        document = self._document_with_validation(
            "DatePicker", "/field/v", "2026-01-01",
            [{"type": "minimum", "value": 1}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_datepicker_rejects_integer(self) -> None:
        document = self._document_with_validation(
            "DatePicker", "/field/v", "2026-01-01",
            [{"type": "integer"}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_datepicker_rejects_minitems(self) -> None:
        document = self._document_with_validation(
            "DatePicker", "/field/v", "2026-01-01",
            [{"type": "minItems", "value": 1}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_switch_rejects_minlength(self) -> None:
        document = self._document_with_validation(
            "Switch", "/field/v", True,
            [{"type": "minLength", "value": 1}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_switch_rejects_minimum(self) -> None:
        document = self._document_with_validation(
            "Switch", "/field/v", True,
            [{"type": "minimum", "value": 1}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID

    def test_switch_rejects_minitems(self) -> None:
        document = self._document_with_validation(
            "Switch", "/field/v", True,
            [{"type": "minItems", "value": 1}],
        )
        assert _error_code(lambda: validate_form_document(document)) == ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID


# ---------------------------------------------------------------------------
# Regression: parent/child JSON Pointer overlap setValue type bypass (ISSUE-57)
# ---------------------------------------------------------------------------


def _example_by_form_id(form_id: str) -> dict[str, Any]:
    return next(ex for ex in _examples() if ex["formId"] == form_id)


def _add_rule(document: dict[str, Any], rule: dict[str, Any]) -> None:
    document.setdefault("rules", []).append(rule)


class TestSetValuePointerOverlap:
    """setValue on a path that is an ancestor or descendant of a bound
    dataPath must validate the resulting value against the affected component's
    type contract."""

    def test_ancestor_replace_rejects_wrong_child_type(self) -> None:
        """setValue(/identity, {companyName: 123}) replaces the parent of
        /identity/companyName (TextInput → expects str|null).  A numeric
        companyName must be rejected."""
        document = deepcopy(_example_by_form_id("conditional-application"))
        _add_rule(
            document,
            {
                "id": "bad-parent-overwrite",
                "event": "change",
                "sourceDataPath": "/identity/personType",
                "when": {"op": "equals", "path": "/identity/personType", "value": "employee"},
                "then": [
                    {
                        "type": "setValue",
                        "targetDataPath": "/identity",
                        "value": {"personType": "employee", "companyName": 123, "workEmail": "a@b.com"},
                    }
                ],
            },
        )
        assert (
            _error_code(lambda: validate_form_document(document))
            == ProtocolErrorCode.DATA_BINDING_INVALID
        )

    def test_ancestor_replace_with_valid_child_types_passes(self) -> None:
        """setValue(/identity, ...) with correct child types must pass."""
        document = deepcopy(_example_by_form_id("conditional-application"))
        _add_rule(
            document,
            {
                "id": "good-parent-overwrite",
                "event": "change",
                "sourceDataPath": "/identity/personType",
                "when": {"op": "equals", "path": "/identity/personType", "value": "employee"},
                "then": [
                    {
                        "type": "setValue",
                        "targetDataPath": "/identity",
                        "value": {
                            "personType": "employee",
                            "companyName": "Acme Corp",
                            "workEmail": "a@b.com",
                        },
                    }
                ],
            },
        )
        validate_form_document(document)

    def test_descendant_modify_rejects_wrong_upload_status(self) -> None:
        """setValue(/trip/attachments/0/status, 'uploading') writes a child
        path of /trip/attachments (Upload).  'uploading' is not a valid
        UploadValueV1 status, so it must be rejected."""
        document = deepcopy(_example_by_form_id("remote-options-application"))
        document["data"]["initialValues"]["trip"]["attachments"] = [
            {
                "fileId": "f1",
                "name": "report.pdf",
                "size": 1024,
                "mimeType": "application/pdf",
                "status": "uploaded",
            }
        ]
        document["data"]["initialValues"]["trip"]["durationDays"] = 5
        _add_rule(
            document,
            {
                "id": "bad-descendant-write",
                "event": "change",
                "sourceDataPath": "/trip/durationDays",
                "when": {
                    "op": "greaterThan",
                    "path": "/trip/durationDays",
                    "value": 0,
                },
                "then": [
                    {
                        "type": "setValue",
                        "targetDataPath": "/trip/attachments/0/status",
                        "value": "uploading",
                    }
                ],
            },
        )
        assert (
            _error_code(lambda: validate_form_document(document))
            == ProtocolErrorCode.DATA_BINDING_INVALID
        )

    def test_non_overlapping_adjacent_path_is_unaffected(self) -> None:
        """A setValue on an adjacent non-overlapping path must not interfere
        with bound component validation."""
        document = deepcopy(_example_by_form_id("conditional-application"))
        _add_rule(
            document,
            {
                "id": "non-overlapping-write",
                "event": "change",
                "sourceDataPath": "/identity/personType",
                "when": {"op": "equals", "path": "/identity/personType", "value": "employee"},
                "then": [
                    {
                        "type": "setValue",
                        "targetDataPath": "/preferences/notify",
                        "value": False,
                    }
                ],
            },
        )
        validate_form_document(document)

    def test_rfc6901_escaped_tokens_are_decoded_for_overlap(self) -> None:
        """A dataPath containing ~0/~1 must be properly decoded when checking
        pointer overlap.  A setValue on the parent path must still enforce the
        child component's type."""
        document = deepcopy(_example_by_form_id("conditional-application"))
        node = _node(document, "TextInput")
        node["dataPath"] = "/data/a~0b/c~1d/field"
        document["data"]["initialValues"] = {
            **document["data"]["initialValues"],
            "data": {"a~b": {"c/d": {"field": "hello"}}},
        }
        _add_rule(
            document,
            {
                "id": "escaped-ancestor-bad",
                "event": "change",
                "sourceDataPath": "/identity/personType",
                "when": {"op": "equals", "path": "/identity/personType", "value": "employee"},
                "then": [
                    {
                        "type": "setValue",
                        "targetDataPath": "/data/a~0b/c~1d",
                        "value": {"field": 999},
                    }
                ],
            },
        )
        assert (
            _error_code(lambda: validate_form_document(document))
            == ProtocolErrorCode.DATA_BINDING_INVALID
        )
