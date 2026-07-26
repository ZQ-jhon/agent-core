"""Trusted form snapshots and server-side submission validation."""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Protocol

from agent_core.a2ui import A2UIFormDocumentV1, validate_form_document


INPUT_COMPONENTS = {
    "TextInput",
    "TextArea",
    "NumberInput",
    "Select",
    "RadioGroup",
    "CheckboxGroup",
    "DatePicker",
    "Switch",
    "Upload",
}
SENSITIVE_KEY_NAMES = {
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "credential",
    "apikey",
    "apikey",
    "accesstoken",
    "refreshtoken",
}


@dataclass(frozen=True)
class FormAction:
    action_id: str
    action_type: str
    source_component_ids: frozenset[str]


@dataclass(frozen=True)
class FieldDefinition:
    data_path: str
    component_id: str
    component_type: str
    validations: tuple[dict[str, Any], ...]
    props: Mapping[str, Any]
    data_source_id: str | None


@dataclass(frozen=True)
class FormSnapshot:
    form_id: str
    revision: int
    initial_values: dict[str, Any]
    actions: Mapping[str, FormAction]
    fields: Mapping[str, FieldDefinition]
    rules: tuple[dict[str, Any], ...]
    component_states: Mapping[str, tuple[bool, bool]]


class FormRegistry(Protocol):
    def get(self, form_id: str) -> FormSnapshot | None:
        """Return the current trusted snapshot for a form, if any."""


class SubmissionPrincipal(Protocol):
    """The minimal trusted subject required by the persistence core."""

    subject_id: str
    tenant_id: str


class InMemoryFormRegistry:
    """Small snapshot registry for host integration, tests, and local demos."""

    def __init__(self, snapshots: Iterable[FormSnapshot] = ()) -> None:
        self._snapshots = {snapshot.form_id: snapshot for snapshot in snapshots}

    def get(self, form_id: str) -> FormSnapshot | None:
        return self._snapshots.get(form_id)

    def replace(self, snapshot: FormSnapshot) -> None:
        self._snapshots[snapshot.form_id] = snapshot

    @classmethod
    def from_documents(
        cls, documents: Iterable[A2UIFormDocumentV1 | Mapping[str, Any]]
    ) -> "InMemoryFormRegistry":
        return cls(build_form_snapshot(document) for document in documents)

    @classmethod
    def from_example_file(cls, path: str | Path) -> "InMemoryFormRegistry":
        bundle = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_documents(bundle["examples"])


class EmptyFormRegistry:
    """Safe production default until a host supplies its approved form source."""

    def get(self, _: str) -> FormSnapshot | None:
        return None


FileReferenceVerifier = Callable[[SubmissionPrincipal, str, str], bool | str]
RemoteOptionVerifier = Callable[[SubmissionPrincipal, FormSnapshot, FieldDefinition, Any], bool]


@dataclass(frozen=True)
class ValidationResult:
    data: dict[str, Any]
    file_references: list[dict[str, str]]
    field_errors: dict[str, list[dict[str, str]]]


class UnknownSubmissionDataPath(ValueError):
    """Signal a request-level data path rejection after idempotency lookup.

    Unknown form-data keys are not field-validation failures: the frozen v1
    contract rejects them as ``400 REQUEST_INVALID`` and must not create an
    idempotency or submission record.  The service layer owns that transport
    mapping so this validation module remains framework-free.
    """


def build_form_snapshot(document: A2UIFormDocumentV1 | Mapping[str, Any]) -> FormSnapshot:
    """Build a persistence view from the single shared Form Profile model."""

    shared_document = (
        document if isinstance(document, A2UIFormDocumentV1) else validate_form_document(document)
    )
    payload = shared_document.model_dump(by_alias=True, exclude_none=True)

    source_component_ids: dict[str, set[str]] = {}
    fields: dict[str, FieldDefinition] = {}
    component_states: dict[str, tuple[bool, bool]] = {}

    for node in _walk_nodes(payload["root"]):
        props = dict(node.get("props", {}))
        component_states[node["id"]] = (
            bool(props.get("visible", True)),
            bool(props.get("disabled", False)),
        )
        action = node.get("action")
        if action:
            source_component_ids.setdefault(action["actionId"], set()).add(node["id"])
        if node.get("type") in INPUT_COMPONENTS:
            data_path = node["dataPath"]
            field = FieldDefinition(
                data_path=data_path,
                component_id=node["id"],
                component_type=node["type"],
                validations=tuple(node.get("validation", [])),
                props=props,
                data_source_id=props.get("dataSourceId"),
            )
            fields[data_path] = field

    actions = {
        action["id"]: FormAction(
            action_id=action["id"],
            action_type=action["type"],
            source_component_ids=frozenset(source_component_ids.get(action["id"], set())),
        )
        for action in payload.get("actions", [])
    }
    initial_values = copy.deepcopy(payload["data"]["initialValues"])
    # ``setValue`` may deliberately assign JSON ``null``.  The general
    # document projection excludes optional ``None`` fields for wire output,
    # so retain rules from their models without ``exclude_none`` for server
    # revalidation.
    rules = tuple(
        copy.deepcopy(rule.model_dump(by_alias=True)) for rule in (shared_document.rules or [])
    )
    return FormSnapshot(
        form_id=payload["formId"],
        revision=payload["revision"],
        initial_values=initial_values,
        actions=actions,
        fields=fields,
        rules=rules,
        component_states=component_states,
    )


def _apply_rules(
    snapshot: FormSnapshot,
    data: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, tuple[bool, bool]]]:
    """Compute the server-side effective value and input state for submitted data."""

    effective_data = copy.deepcopy(data)
    state = {component_id: list(values) for component_id, values in snapshot.component_states.items()}
    for rule in snapshot.rules:
        effects = rule.get("then", []) if _evaluate_condition(rule["when"], effective_data) else rule.get("else", [])
        for effect in effects:
            effect_type = effect["type"]
            if effect_type == "setVisible":
                state[effect["targetComponentId"]][0] = effect["value"]
            elif effect_type == "setDisabled":
                state[effect["targetComponentId"]][1] = effect["value"]
            elif effect_type == "setValue":
                _set_pointer(effective_data, effect["targetDataPath"], copy.deepcopy(effect["value"]))
    return effective_data, {component_id: tuple(values) for component_id, values in state.items()}


def _evaluate_condition(condition: dict[str, Any], data: dict[str, Any]) -> bool:
    op = condition["op"]
    if op == "and":
        return all(_evaluate_condition(child, data) for child in condition["args"])
    if op == "or":
        return any(_evaluate_condition(child, data) for child in condition["args"])
    if op == "not":
        return not _evaluate_condition(condition["arg"], data)

    actual, exists = _resolve_pointer(data, condition["path"])
    if op == "exists":
        return exists
    if op == "isEmpty":
        return not exists or not _has_value(actual)
    if not exists:
        return False
    expected = condition["value"]
    if op == "equals":
        return _json_equal(actual, expected)
    if op == "notEquals":
        return not _json_equal(actual, expected)
    if op in {"greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"}:
        if (
            not isinstance(actual, (int, float))
            or isinstance(actual, bool)
            or not isinstance(expected, (int, float))
            or isinstance(expected, bool)
        ):
            return False
        if op == "greaterThan":
            return actual > expected
        if op == "greaterThanOrEqual":
            return actual >= expected
        if op == "lessThan":
            return actual < expected
        return actual <= expected
    if op in {"in", "notIn"}:
        if not isinstance(expected, list):
            return False
        contained = any(_json_equal(actual, candidate) for candidate in expected)
        return contained if op == "in" else not contained
    return False


def _json_equal(left: Any, right: Any) -> bool:
    return _canonical_option(left) == _canonical_option(right)


def validate_submission_data(
    *,
    snapshot: FormSnapshot,
    principal: Principal,
    data: dict[str, Any],
    file_reference_verifier: FileReferenceVerifier | None,
    remote_option_verifier: RemoteOptionVerifier | None,
) -> ValidationResult:
    """Reject non-whitelisted or unsafe values and return a safe data projection."""

    errors: dict[str, list[dict[str, str]]] = {}
    # Merge only declared input into trusted initial values so rules can be
    # evaluated server-side even when a client correctly omits hidden fields.
    # Unknown paths intentionally raise before field validation; callers run
    # this only after the idempotency lookup mandated by the frozen contract.
    projected = _project_submission_data(snapshot, data)
    _validate_shape(snapshot.initial_values, projected, "", snapshot.fields, errors)
    _reject_sensitive_keys(data, "", errors)
    sanitized, component_states = _apply_rules(snapshot, projected)

    file_references: list[dict[str, str]] = []
    for path, field in snapshot.fields.items():
        visible, disabled = component_states.get(field.component_id, (True, False))
        if not visible or disabled:
            # Conditional hidden/disabled controls do not participate in
            # server-side field validation. Rule effects have already applied
            # to the normalized projection, so stale client values cannot win.
            continue
        _submitted_value, submitted = _resolve_pointer(data, path)
        if not submitted:
            _add_error(errors, path, "REQUIRED", "The complete form data is required.")
            continue
        value, exists = _resolve_pointer(sanitized, path)
        if not exists:
            _add_error(errors, path, "REQUIRED", "The complete form data is required.")
            continue
        _validate_field_type(field, value, errors)
        _validate_field_rules(field, value, errors)
        _validate_static_options(field, value, errors)

        if _has_value(value) and field.data_source_id:
            if remote_option_verifier is None or not remote_option_verifier(
                principal, snapshot, field, value
            ):
                _add_error(
                    errors,
                    path,
                    "REMOTE_OPTION_UNVERIFIED",
                    "The selected remote option could not be verified.",
                )

        if field.component_type == "Upload" and isinstance(value, list):
            safe_items = _validate_file_references(
                principal,
                field,
                value,
                file_reference_verifier,
                errors,
                file_references,
            )
            if safe_items is not None:
                _set_pointer(sanitized, path, safe_items)

    return ValidationResult(
        data=sanitized,
        file_references=file_references,
        field_errors=errors,
    )


def _project_submission_data(snapshot: FormSnapshot, data: dict[str, Any]) -> dict[str, Any]:
    return _merge_submission_value(
        expected=snapshot.initial_values,
        actual=data,
        path="",
        fields=snapshot.fields,
    )


def _merge_submission_value(
    *,
    expected: Any,
    actual: Any,
    path: str,
    fields: Mapping[str, FieldDefinition],
) -> Any:
    """Overlay submitted keys while rejecting only undeclared data paths."""

    if path in fields:
        # Field type/range checks intentionally happen later so they can be
        # rendered as RFC 6901 field errors rather than parser failures.
        return copy.deepcopy(actual)
    if isinstance(expected, dict) and isinstance(actual, dict):
        projected = copy.deepcopy(expected)
        for key, value in actual.items():
            child_path = _join_pointer(path, key)
            if key not in expected:
                raise UnknownSubmissionDataPath(child_path)
            projected[key] = _merge_submission_value(
                expected=expected[key],
                actual=value,
                path=child_path,
                fields=fields,
            )
        return projected
    return copy.deepcopy(actual)


def _walk_nodes(node: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield node
    for child in node.get("children", []):
        yield from _walk_nodes(child)


def _validate_shape(
    expected: Any,
    actual: Any,
    path: str,
    fields: Mapping[str, FieldDefinition],
    errors: dict[str, list[dict[str, str]]],
) -> None:
    # Input values—including arrays—are validated by their component and
    # declared validators below.  Their initial value is not a length/type
    # template for later submissions.
    if path in fields:
        return
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            _add_error(errors, path or "/data", "TYPE_INVALID", "Expected an object.")
            return
        for key in actual:
            if key not in expected:
                _add_error(
                    errors,
                    _join_pointer(path, key),
                    "REQUEST_INVALID",
                    "This data field is not declared by the current form revision.",
                )
        for key, expected_value in expected.items():
            child_path = _join_pointer(path, key)
            if key not in actual:
                _add_error(
                    errors,
                    child_path,
                    "REQUIRED",
                    "The complete form data is required.",
                )
                continue
            _validate_shape(expected_value, actual[key], child_path, fields, errors)
        return

    if isinstance(expected, list):
        if not isinstance(actual, list):
            _add_error(errors, path, "TYPE_INVALID", "Expected an array.")
            return
        if expected:
            if len(actual) != len(expected):
                _add_error(
                    errors,
                    path,
                    "ARRAY_LENGTH_INVALID",
                    "Array length does not match the current form revision.",
                )
            for index, expected_value in enumerate(expected):
                if index >= len(actual):
                    continue
                _validate_shape(
                    expected_value,
                    actual[index],
                    _join_pointer(path, str(index)),
                    fields,
                    errors,
                )
        return

    if expected is not None and not _same_json_type(expected, actual):
        _add_error(errors, path, "TYPE_INVALID", "Value type does not match the form.")


def _validate_field_type(
    field: FieldDefinition,
    value: Any,
    errors: dict[str, list[dict[str, str]]],
) -> None:
    if value is None:
        return
    expected = field.component_type
    valid = True
    if expected in {"TextInput", "TextArea", "DatePicker"}:
        valid = isinstance(value, str)
        if valid and expected == "DatePicker":
            try:
                valid = re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) is not None
                if valid:
                    date.fromisoformat(value)
            except ValueError:
                valid = False
    elif expected == "NumberInput":
        valid = isinstance(value, (int, float)) and not isinstance(value, bool)
    elif expected in {"Select", "RadioGroup"}:
        valid = isinstance(value, (str, int, float, bool))
    elif expected in {"CheckboxGroup", "Upload"}:
        valid = isinstance(value, list)
    elif expected == "Switch":
        valid = isinstance(value, bool)
    if not valid:
        _add_error(errors, field.data_path, "TYPE_INVALID", "Value type does not match the field.")
    elif expected == "DatePicker":
        _validate_date_bounds(field, value, errors)


def _validate_field_rules(
    field: FieldDefinition,
    value: Any,
    errors: dict[str, list[dict[str, str]]],
) -> None:
    for rule in field.validations:
        rule_type = rule.get("type")
        message = rule.get("message", "The field value is invalid.")
        if rule_type == "required" and not _has_value(value):
            _add_error(errors, field.data_path, _rule_code(rule, "FIELD_REQUIRED"), message)
        elif value is None:
            continue
        elif rule_type == "pattern" and isinstance(value, str):
            try:
                matches = re.fullmatch(str(rule["value"]), value) is not None
            except re.error:
                matches = False
            if not matches:
                _add_error(errors, field.data_path, _rule_code(rule, "PATTERN_MISMATCH"), message)
        elif rule_type == "minLength" and isinstance(value, str) and len(value) < rule["value"]:
            _add_error(errors, field.data_path, _rule_code(rule, "STRING_TOO_SHORT"), message)
        elif rule_type == "maxLength" and isinstance(value, str) and len(value) > rule["value"]:
            _add_error(errors, field.data_path, _rule_code(rule, "STRING_TOO_LONG"), message)
        elif rule_type == "integer" and (
            not isinstance(value, int) or isinstance(value, bool)
        ):
            _add_error(errors, field.data_path, _rule_code(rule, "INTEGER_REQUIRED"), message)
        elif rule_type == "minimum" and isinstance(value, (int, float)) and not isinstance(value, bool):
            if value < rule["value"]:
                _add_error(errors, field.data_path, _rule_code(rule, "NUMBER_TOO_SMALL"), message)
        elif rule_type == "maximum" and isinstance(value, (int, float)) and not isinstance(value, bool):
            if value > rule["value"]:
                _add_error(errors, field.data_path, _rule_code(rule, "NUMBER_TOO_LARGE"), message)
        elif rule_type == "minItems" and isinstance(value, list) and len(value) < rule["value"]:
            _add_error(errors, field.data_path, _rule_code(rule, "ARRAY_TOO_SHORT"), message)
        elif rule_type == "maxItems" and isinstance(value, list) and len(value) > rule["value"]:
            _add_error(errors, field.data_path, _rule_code(rule, "ARRAY_TOO_LONG"), message)


def _rule_code(rule: Mapping[str, Any], default: str) -> str:
    code = rule.get("code")
    return code if isinstance(code, str) and code else default


def _validate_date_bounds(
    field: FieldDefinition,
    value: str,
    errors: dict[str, list[dict[str, str]]],
) -> None:
    parsed = _parse_iso_date(value)
    min_date = field.props.get("minDate")
    max_date = field.props.get("maxDate")
    if min_date is not None and parsed < _parse_iso_date(min_date):
        _add_error(
            errors,
            field.data_path,
            "DATE_MINIMUM",
            "Date is earlier than the field minimum.",
        )
    if max_date is not None and parsed > _parse_iso_date(max_date):
        _add_error(
            errors,
            field.data_path,
            "DATE_MAXIMUM",
            "Date is later than the field maximum.",
        )


def _parse_iso_date(value: Any) -> date:
    if not isinstance(value, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) is None:
        raise ValueError("Date values must use YYYY-MM-DD")
    return date.fromisoformat(value)


def _validate_static_options(
    field: FieldDefinition,
    value: Any,
    errors: dict[str, list[dict[str, str]]],
) -> None:
    options = field.props.get("options")
    if not options or value is None:
        return
    allowed = {_canonical_option(item["value"]) for item in options}
    values = value if isinstance(value, list) else [value]
    canonical_values = [_canonical_option(item) for item in values]
    if any(item not in allowed for item in canonical_values):
        _add_error(
            errors,
            field.data_path,
            "OPTION_INVALID",
            "The selected option is not allowed by the current form revision.",
        )
    if field.component_type == "CheckboxGroup" and len(set(canonical_values)) != len(canonical_values):
        _add_error(
            errors,
            field.data_path,
            "DUPLICATE_OPTION",
            "Checkbox selections must not contain duplicate values.",
        )


def _validate_file_references(
    principal: Principal,
    field: FieldDefinition,
    values: list[Any],
    verifier: FileReferenceVerifier | None,
    errors: dict[str, list[dict[str, str]]],
    result_references: list[dict[str, str]],
) -> list[dict[str, str]] | None:
    safe_items: list[dict[str, str]] = []
    valid = True
    max_files = field.props.get("maxFiles")
    if isinstance(max_files, int) and len(values) > max_files:
        _add_error(
            errors,
            field.data_path,
            "MAX_FILES",
            "The number of uploaded files exceeds the field limit.",
        )
        valid = False
    for item in values:
        if (
            not isinstance(item, dict)
            or set(item) != {"fileId", "name", "size", "mimeType", "status"}
            or not isinstance(item["fileId"], str)
            or not item["fileId"]
            or not isinstance(item["name"], str)
            or not item["name"]
            or not isinstance(item["size"], (int, float))
            or isinstance(item["size"], bool)
            or item["size"] < 0
            or not isinstance(item["mimeType"], str)
            or not item["mimeType"]
            or item["status"] != "uploaded"
        ):
            _add_error(
                errors,
                field.data_path,
                "FILE_REFERENCE_INVALID",
                "Upload values must match the completed UploadValue contract.",
            )
            valid = False
            continue
        file_id = item["fileId"]
        verified = verifier(principal, field.data_path, file_id) if verifier else False
        if not verified:
            _add_error(
                errors,
                field.data_path,
                "FILE_REFERENCE_UNVERIFIED",
                "The file reference could not be authorized.",
            )
            valid = False
            continue
        safe_file_id = verified if isinstance(verified, str) else file_id
        reference = {"fileId": safe_file_id}
        safe_items.append(reference)
        result_references.append({"path": field.data_path, **reference})
    return safe_items if valid else None


def _reject_sensitive_keys(
    value: Any,
    path: str,
    errors: dict[str, list[dict[str, str]]],
) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = _join_pointer(path, key)
            normalized = re.sub(r"[^a-z0-9]", "", key.lower())
            if normalized in SENSITIVE_KEY_NAMES:
                _add_error(
                    errors,
                    child_path,
                    "SENSITIVE_FIELD_REJECTED",
                    "Sensitive credentials must not be submitted in form data.",
                )
            _reject_sensitive_keys(child, child_path, errors)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_sensitive_keys(child, _join_pointer(path, str(index)), errors)


def _resolve_pointer(value: Any, pointer: str) -> tuple[Any, bool]:
    current = value
    for raw_token in pointer.removeprefix("/").split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            if token not in current:
                return None, False
            current = current[token]
        elif isinstance(current, list):
            if not token.isdigit() or (len(token) > 1 and token.startswith("0")):
                return None, False
            index = int(token)
            if index >= len(current):
                return None, False
            current = current[index]
        else:
            return None, False
    return current, True


def _set_pointer(value: dict[str, Any], pointer: str, replacement: Any) -> None:
    current: Any = value
    tokens = pointer.removeprefix("/").split("/")
    for raw_token in tokens[:-1]:
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            current = current[token]
        elif isinstance(current, list):
            current = current[int(token)]
        else:
            raise ValueError(f"Cannot resolve JSON Pointer {pointer!r}")
    final_token = tokens[-1].replace("~1", "/").replace("~0", "~")
    if isinstance(current, dict):
        current[final_token] = replacement
    elif isinstance(current, list):
        current[int(final_token)] = replacement
    else:
        raise ValueError(f"Cannot set JSON Pointer {pointer!r}")


def _join_pointer(parent: str, token: str) -> str:
    escaped = token.replace("~", "~0").replace("/", "~1")
    return f"{parent}/{escaped}" if parent else f"/{escaped}"


def _same_json_type(expected: Any, actual: Any) -> bool:
    if isinstance(expected, bool):
        return isinstance(actual, bool)
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        return isinstance(actual, (int, float)) and not isinstance(actual, bool)
    return isinstance(actual, type(expected))


def _canonical_option(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _has_value(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    return value is not None and value != []


def _add_error(
    errors: dict[str, list[dict[str, str]]],
    path: str,
    code: str,
    message: str,
) -> None:
    target = path or "/data"
    errors.setdefault(target, []).append({"code": code, "message": message})
