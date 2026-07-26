"""Strict shared models for the project-local A2UI Form Profile v1.

This module deliberately owns only protocol shape and safe structural semantics.
It does not resolve endpoint keys, authenticate a caller, execute actions, or
make business-field decisions.  In particular, ``context`` remains untrusted
JSON and is never converted into a terminal identity.
"""

from __future__ import annotations

import copy
import math
import re
from collections.abc import Mapping
from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal, TypeAlias, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator


A2UI_FORM_SCHEMA_VERSION = "1.0.0"

_STABLE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
_DATA_PATH_PATTERN = r"^/(?:[^~/]|~[01])+(?:/(?:[^~/]|~[01])+)*$"
_ENDPOINT_KEY_PATTERN = r"^[A-Za-z][A-Za-z0-9._-]*$"
_ERROR_CODE_PATTERN = r"^[A-Z][A-Z0-9_]*$"
_SEMVER_PATTERN = r"^[0-9]+\.[0-9]+\.[0-9]+$"

StableId = Annotated[
    str,
    Field(min_length=1, max_length=128, pattern=_STABLE_ID_PATTERN),
]
DataPath = Annotated[
    str,
    Field(min_length=1, max_length=512, pattern=_DATA_PATH_PATTERN),
]
EndpointKey = Annotated[
    str,
    Field(min_length=1, max_length=128, pattern=_ENDPOINT_KEY_PATTERN),
]
ProtocolErrorName = Annotated[str, Field(pattern=_ERROR_CODE_PATTERN)]
SchemaVersion = Literal[A2UI_FORM_SCHEMA_VERSION]
ComponentType = Literal[
    "Form",
    "Section",
    "TextInput",
    "TextArea",
    "NumberInput",
    "Select",
    "RadioGroup",
    "CheckboxGroup",
    "DatePicker",
    "Switch",
    "Upload",
    "Button",
    "Alert",
    "Markdown",
]

SUPPORTED_COMPONENT_TYPES = frozenset(
    {
        "Form",
        "Section",
        "TextInput",
        "TextArea",
        "NumberInput",
        "Select",
        "RadioGroup",
        "CheckboxGroup",
        "DatePicker",
        "Switch",
        "Upload",
        "Button",
        "Alert",
        "Markdown",
    }
)
_INPUT_COMPONENT_TYPES = frozenset(
    {
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
)
_LEAF_COMPONENT_TYPES = _INPUT_COMPONENT_TYPES | {
    "Button",
    "Alert",
    "Markdown",
}


class ProtocolErrorCode(str, Enum):
    """Stable protocol errors that the model layer may return."""

    REQUEST_INVALID = "REQUEST_INVALID"
    SCHEMA_INVALID = "SCHEMA_INVALID"
    SCHEMA_VERSION_UNSUPPORTED = "SCHEMA_VERSION_UNSUPPORTED"
    SCHEMA_SEMANTIC_INVALID = "SCHEMA_SEMANTIC_INVALID"
    COMPONENT_UNSUPPORTED = "COMPONENT_UNSUPPORTED"
    DATA_BINDING_INVALID = "DATA_BINDING_INVALID"
    RULE_INVALID = "RULE_INVALID"
    RULE_EXECUTION_LIMIT = "RULE_EXECUTION_LIMIT"
    RULE_PATH_NOT_FOUND = "RULE_PATH_NOT_FOUND"
    DATA_SOURCE_DESCRIPTOR_MISMATCH = "DATA_SOURCE_DESCRIPTOR_MISMATCH"
    ACTION_FAILED = "ACTION_FAILED"
    FIELD_ERROR_UNMAPPED = "FIELD_ERROR_UNMAPPED"


_PROTOCOL_ERROR_MESSAGES: dict[ProtocolErrorCode, str] = {
    ProtocolErrorCode.REQUEST_INVALID: "The A2UI request is invalid.",
    ProtocolErrorCode.SCHEMA_INVALID: "The A2UI document does not match Form Profile v1.",
    ProtocolErrorCode.SCHEMA_VERSION_UNSUPPORTED: "The A2UI schema version is not supported.",
    ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID: "The A2UI document contains an invalid reference or structure.",
    ProtocolErrorCode.COMPONENT_UNSUPPORTED: "The A2UI document contains an unsupported component.",
    ProtocolErrorCode.DATA_BINDING_INVALID: "The A2UI document contains an invalid data binding.",
    ProtocolErrorCode.RULE_INVALID: "The A2UI document contains an invalid rule.",
    ProtocolErrorCode.RULE_EXECUTION_LIMIT: "The A2UI rule execution limit was reached.",
    ProtocolErrorCode.RULE_PATH_NOT_FOUND: "The A2UI rule references a path that does not exist.",
    ProtocolErrorCode.DATA_SOURCE_DESCRIPTOR_MISMATCH: "The A2UI data source descriptor is not valid.",
    ProtocolErrorCode.ACTION_FAILED: "The A2UI action failed.",
    ProtocolErrorCode.FIELD_ERROR_UNMAPPED: "The A2UI field error could not be mapped.",
}
class ProtocolValidationError(ValueError):
    """A stable, non-reflective error for untrusted A2UI protocol input."""

    def __init__(self, code: ProtocolErrorCode) -> None:
        self.code = code
        super().__init__(_PROTOCOL_ERROR_MESSAGES[code])

    def as_general_error(self) -> "GeneralErrorV1":
        return GeneralErrorV1(
            code=self.code.value,
            message=_PROTOCOL_ERROR_MESSAGES[self.code],
            retryable=False,
        )


class _SemanticIssue(ValueError):
    def __init__(self, code: ProtocolErrorCode) -> None:
        self.code = code
        super().__init__(_PROTOCOL_ERROR_MESSAGES[code])


class A2UIModel(BaseModel):
    """Base configuration for wire-level models.

    Every structured object forbids unknown keys.  Generic JSON value fields
    are validated separately, because they intentionally carry arbitrary form
    data or untrusted contextual data.
    """

    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=False)


def _ensure_json_value(value: Any) -> Any:
    """Accept only JSON-compatible data without coercion or execution."""

    if value is None or type(value) in {str, bool, int}:
        return value
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("JSON numbers must be finite")
        return value
    if type(value) is list:
        for item in value:
            _ensure_json_value(item)
        return value
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError("JSON object keys must be strings")
            _ensure_json_value(item)
        return value
    raise ValueError("value must be JSON-compatible")


def _ensure_json_object(value: Any) -> dict[str, Any]:
    _ensure_json_value(value)
    if type(value) is not dict:
        raise ValueError("value must be a JSON object")
    return value


def _json_scalar_marker(value: str | int | float | bool) -> tuple[type[Any], Any]:
    return type(value), value


def _require_unique_option_values(options: list["Option"]) -> None:
    seen: set[tuple[type[Any], Any]] = set()
    for option in options:
        marker = _json_scalar_marker(option.value)
        if marker in seen:
            raise ValueError("option values must be unique")
        seen.add(marker)


def _is_number(value: Any) -> bool:
    return type(value) in {int, float} and math.isfinite(value)


def _is_scalar(value: Any) -> bool:
    return type(value) in {str, bool, int, float}


def _same_json_scalar(left: Any, right: Any) -> bool:
    return type(left) is type(right) and left == right


class Option(A2UIModel):
    label: Annotated[str, Field(min_length=1, max_length=200)]
    value: str | int | float | bool
    disabled: bool = False


class ConfirmSpec(A2UIModel):
    title: Annotated[str, Field(min_length=1, max_length=120)]
    message: Annotated[str, Field(min_length=1, max_length=500)]
    confirm_label: Annotated[str, Field(min_length=1, max_length=40)] = Field(
        default=None, alias="confirmLabel"
    )
    cancel_label: Annotated[str, Field(min_length=1, max_length=40)] = Field(
        default=None, alias="cancelLabel"
    )


class ActionBinding(A2UIModel):
    action_id: StableId = Field(alias="actionId")
    confirm: ConfirmSpec = None


class RequiredValidator(A2UIModel):
    type: Literal["required"]
    message: Annotated[str, Field(min_length=1, max_length=300)] = None
    code: ProtocolErrorName = None


class LengthValidator(A2UIModel):
    type: Literal["minLength", "maxLength", "minItems", "maxItems"]
    value: Annotated[int, Field(ge=0)]
    message: Annotated[str, Field(min_length=1, max_length=300)] = None
    code: ProtocolErrorName = None


class NumberValidator(A2UIModel):
    type: Literal["minimum", "maximum"]
    value: float | int
    message: Annotated[str, Field(min_length=1, max_length=300)] = None
    code: ProtocolErrorName = None

    @field_validator("value")
    @classmethod
    def _finite_value(cls, value: float | int) -> float | int:
        if not _is_number(value):
            raise ValueError("validator value must be a finite number")
        return value


_RE2_UNSUPPORTED_PATTERN = re.compile(
    r"(?:\\[1-9]|\\k<|\(\?(?:[=!<]|P[=<]|\(|R|&))"
)


class PatternValidator(A2UIModel):
    type: Literal["pattern"]
    value: Annotated[str, Field(min_length=1, max_length=256)]
    message: Annotated[str, Field(min_length=1, max_length=300)] = None
    code: ProtocolErrorName = None

    @field_validator("value")
    @classmethod
    def _re2_compatible(cls, value: str) -> str:
        if _RE2_UNSUPPORTED_PATTERN.search(value):
            raise ValueError("pattern uses a feature outside the RE2 subset")
        return value


class IntegerValidator(A2UIModel):
    type: Literal["integer"]
    message: Annotated[str, Field(min_length=1, max_length=300)] = None
    code: ProtocolErrorName = None


Validator: TypeAlias = Annotated[
    Union[
        RequiredValidator,
        LengthValidator,
        NumberValidator,
        PatternValidator,
        IntegerValidator,
    ],
    Field(discriminator="type"),
]


class FormProps(A2UIModel):
    title: Annotated[str, Field(max_length=200)] = None
    description: Annotated[str, Field(max_length=1000)] = None
    submit_on_enter: bool = Field(default=False, alias="submitOnEnter")


class SectionProps(A2UIModel):
    title: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(max_length=1000)] = None
    collapsible: bool = False
    default_collapsed: bool = Field(default=False, alias="defaultCollapsed")
    visible: bool = True


class CommonInputProps(A2UIModel):
    label: Annotated[str, Field(min_length=1, max_length=200)]
    help_text: Annotated[str, Field(max_length=500)] = Field(default=None, alias="helpText")
    disabled: bool = False
    visible: bool = True


class TextInputProps(CommonInputProps):
    placeholder: Annotated[str, Field(max_length=200)] = None
    auto_complete: Annotated[str, Field(max_length=80)] = Field(
        default=None, alias="autoComplete"
    )
    input_mode: Literal["text", "email", "tel", "url", "search"] = Field(
        default=None, alias="inputMode"
    )
    read_only: bool = Field(default=False, alias="readOnly")


class TextAreaProps(CommonInputProps):
    placeholder: Annotated[str, Field(max_length=200)] = None
    rows: Annotated[int, Field(ge=2, le=20)] = 4
    max_rows: Annotated[int, Field(ge=2, le=40)] = Field(default=None, alias="maxRows")

    @model_validator(mode="after")
    def _rows_are_ordered(self) -> "TextAreaProps":
        if self.max_rows is not None and self.max_rows < self.rows:
            raise ValueError("maxRows must be greater than or equal to rows")
        return self


class NumberInputProps(CommonInputProps):
    placeholder: Annotated[str, Field(max_length=200)] = None
    step: Annotated[float | int, Field(gt=0)] = 1
    unit: Annotated[str, Field(max_length=30)] = None

    @field_validator("step")
    @classmethod
    def _finite_step(cls, value: float | int) -> float | int:
        if not _is_number(value):
            raise ValueError("step must be a finite number")
        return value


class SelectProps(CommonInputProps):
    placeholder: Annotated[str, Field(max_length=200)] = None
    clearable: bool = True
    options: Annotated[list[Option], Field(min_length=1)] = None
    data_source_id: StableId = Field(default=None, alias="dataSourceId")

    @model_validator(mode="after")
    def _exactly_one_data_source(self) -> "SelectProps":
        if (self.options is None) == (self.data_source_id is None):
            raise ValueError("Select requires exactly one of options or dataSourceId")
        if self.options is not None:
            _require_unique_option_values(self.options)
        return self


class ChoiceProps(CommonInputProps):
    options: Annotated[list[Option], Field(min_length=1)]
    orientation: Literal["horizontal", "vertical"] = "vertical"

    @model_validator(mode="after")
    def _unique_options(self) -> "ChoiceProps":
        _require_unique_option_values(self.options)
        return self


class DatePickerProps(CommonInputProps):
    placeholder: Annotated[str, Field(max_length=200)] = None
    min_date: str = Field(default=None, alias="minDate")
    max_date: str = Field(default=None, alias="maxDate")

    @field_validator("min_date", "max_date")
    @classmethod
    def _iso_date(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                datetime.fromisoformat(f"{value}T00:00:00")
            except ValueError as exc:
                raise ValueError("date must use YYYY-MM-DD") from exc
        return value

    @model_validator(mode="after")
    def _date_bounds_are_ordered(self) -> "DatePickerProps":
        if self.min_date is not None and self.max_date is not None:
            if self.min_date > self.max_date:
                raise ValueError("minDate must not be after maxDate")
        return self


class SwitchProps(CommonInputProps):
    on_label: Annotated[str, Field(max_length=40)] = Field(default=None, alias="onLabel")
    off_label: Annotated[str, Field(max_length=40)] = Field(default=None, alias="offLabel")


class UploadProps(CommonInputProps):
    accept: list[Annotated[str, Field(min_length=1, max_length=100)]] = None
    max_files: Annotated[int, Field(ge=1, le=20)] = Field(default=1, alias="maxFiles")
    max_size_bytes: Annotated[int, Field(ge=1)] = Field(default=None, alias="maxSizeBytes")
    button_label: Annotated[str, Field(max_length=80)] = Field(default=None, alias="buttonLabel")


class ButtonProps(A2UIModel):
    label: Annotated[str, Field(min_length=1, max_length=80)]
    variant: Literal["primary", "secondary", "danger", "text"] = "secondary"
    loading_label: Annotated[str, Field(max_length=80)] = Field(default=None, alias="loadingLabel")
    disabled: bool = False
    visible: bool = True


class AlertProps(A2UIModel):
    title: Annotated[str, Field(max_length=120)] = None
    message: Annotated[str, Field(min_length=1, max_length=2000)]
    variant: Literal["info", "success", "warning", "error"] = "info"
    dismissible: bool = False
    visible: bool = True


class MarkdownProps(A2UIModel):
    content: Annotated[str, Field(max_length=20000)]
    aria_label: Annotated[str, Field(max_length=200)] = Field(default=None, alias="ariaLabel")
    visible: bool = True


_PROP_MODELS: dict[str, type[A2UIModel]] = {
    "Form": FormProps,
    "Section": SectionProps,
    "TextInput": TextInputProps,
    "TextArea": TextAreaProps,
    "NumberInput": NumberInputProps,
    "Select": SelectProps,
    "RadioGroup": ChoiceProps,
    "CheckboxGroup": ChoiceProps,
    "DatePicker": DatePickerProps,
    "Switch": SwitchProps,
    "Upload": UploadProps,
    "Button": ButtonProps,
    "Alert": AlertProps,
    "Markdown": MarkdownProps,
}


class SubmitAction(A2UIModel):
    id: StableId
    type: Literal["submit"]
    endpoint_key: EndpointKey = Field(alias="endpointKey")
    method: Literal["POST"]
    timeout_ms: Annotated[int, Field(ge=1000, le=60000)] = Field(
        default=15000, alias="timeoutMs"
    )


class ResetAction(A2UIModel):
    id: StableId
    type: Literal["reset"]


class UploadAction(A2UIModel):
    id: StableId
    type: Literal["upload"]
    endpoint_key: EndpointKey = Field(alias="endpointKey")
    method: Literal["POST"]
    field_name: Annotated[str, Field(min_length=1, max_length=80)] = Field(
        default="file", alias="fieldName"
    )
    timeout_ms: Annotated[int, Field(ge=1000, le=120000)] = Field(
        default=30000, alias="timeoutMs"
    )


ActionDefinition: TypeAlias = Annotated[
    Union[SubmitAction, ResetAction, UploadAction],
    Field(discriminator="type"),
]


class RemoteOptionsSource(A2UIModel):
    id: StableId
    type: Literal["remoteOptions"]
    endpoint_key: EndpointKey = Field(alias="endpointKey")


class ValueCondition(A2UIModel):
    op: Literal[
        "equals",
        "notEquals",
        "greaterThan",
        "greaterThanOrEqual",
        "lessThan",
        "lessThanOrEqual",
        "in",
        "notIn",
    ]
    path: DataPath
    value: Any

    @field_validator("value", mode="before")
    @classmethod
    def _json_value(cls, value: Any) -> Any:
        return _ensure_json_value(value)

    @model_validator(mode="after")
    def _membership_values_are_arrays(self) -> "ValueCondition":
        if self.op in {"in", "notIn"} and type(self.value) is not list:
            raise ValueError("in and notIn condition values must be arrays")
        return self


class PathCondition(A2UIModel):
    op: Literal["exists", "isEmpty"]
    path: DataPath


class LogicalCondition(A2UIModel):
    op: Literal["and", "or"]
    args: Annotated[list["Condition"], Field(min_length=1, max_length=20)]


class NotCondition(A2UIModel):
    op: Literal["not"]
    arg: "Condition"


Condition: TypeAlias = Annotated[
    Union[ValueCondition, PathCondition, LogicalCondition, NotCondition],
    Field(discriminator="op"),
]


class ComponentStateEffect(A2UIModel):
    type: Literal["setVisible", "setDisabled"]
    target_component_id: StableId = Field(alias="targetComponentId")
    value: bool


class SetValueEffect(A2UIModel):
    type: Literal["setValue"]
    target_data_path: DataPath = Field(alias="targetDataPath")
    value: Any

    @field_validator("value", mode="before")
    @classmethod
    def _json_value(cls, value: Any) -> Any:
        return _ensure_json_value(value)


RuleEffect: TypeAlias = Annotated[
    Union[ComponentStateEffect, SetValueEffect],
    Field(discriminator="type"),
]


class LinkRule(A2UIModel):
    id: StableId
    event: Literal["change"]
    source_data_path: DataPath = Field(alias="sourceDataPath")
    when: Condition
    then: Annotated[list[RuleEffect], Field(min_length=1, max_length=20)]
    else_: Annotated[list[RuleEffect], Field(max_length=20)] = Field(
        default=None, alias="else"
    )


class ComponentNode(A2UIModel):
    id: StableId
    type: ComponentType
    props: dict[str, Any]
    children: list["ComponentNode"]
    data_path: DataPath = Field(default=None, alias="dataPath")
    action: ActionBinding = None
    validation: list[Validator] = None

    @field_validator("props", mode="before")
    @classmethod
    def _props_are_json(cls, value: Any) -> dict[str, Any]:
        return _ensure_json_object(value)

    @model_validator(mode="after")
    def _component_shape(self) -> "ComponentNode":
        try:
            _PROP_MODELS[self.type].model_validate(self.props)
        except ValidationError as exc:
            raise ValueError("component props are not allowed for this type") from exc

        if self.type in _LEAF_COMPONENT_TYPES and self.children:
            raise ValueError("leaf components cannot have children")

        if self.type == "Form":
            if not self.children:
                raise ValueError("Form requires at least one child")
            if self.data_path is not None or self.action is not None or self.validation is not None:
                raise ValueError("Form cannot bind data, actions, or validators")
        elif self.type == "Section":
            if self.data_path is not None or self.action is not None or self.validation is not None:
                raise ValueError("Section cannot bind data, actions, or validators")
        elif self.type == "Upload":
            if self.data_path is None or self.action is None:
                raise ValueError("Upload requires dataPath and action")
        elif self.type in _INPUT_COMPONENT_TYPES:
            if self.data_path is None:
                raise ValueError("input components require dataPath")
            if self.action is not None:
                raise ValueError("input components cannot bind actions")
        elif self.type == "Button":
            if self.action is None:
                raise ValueError("Button requires action")
            if self.data_path is not None or self.validation is not None:
                raise ValueError("Button cannot bind data or validators")
        else:  # Alert and Markdown
            if self.data_path is not None or self.action is not None or self.validation is not None:
                raise ValueError("display components cannot bind data, actions, or validators")
        return self


class DocumentData(A2UIModel):
    initial_values: dict[str, Any] = Field(alias="initialValues")

    @field_validator("initial_values", mode="before")
    @classmethod
    def _json_object(cls, value: Any) -> dict[str, Any]:
        return _ensure_json_object(value)


class DocumentMeta(A2UIModel):
    locale: Annotated[str, Field(min_length=2, max_length=35)] = None
    trace_id: StableId = Field(default=None, alias="traceId")
    title: Annotated[str, Field(max_length=200)] = None


def _validate_rfc3339(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("timestamp must use RFC 3339 format") from exc
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a UTC offset")
    return value


class A2UIFormDocumentV1(A2UIModel):
    schema_version: SchemaVersion = Field(alias="schemaVersion")
    request_id: StableId = Field(alias="requestId")
    form_id: StableId = Field(alias="formId")
    revision: Annotated[int, Field(ge=1)]
    generated_at: str = Field(default=None, alias="generatedAt")
    expires_at: str = Field(default=None, alias="expiresAt")
    root: ComponentNode
    data: DocumentData
    actions: list[ActionDefinition]
    data_sources: list[RemoteOptionsSource] = Field(default=None, alias="dataSources")
    rules: list[LinkRule] = None
    meta: DocumentMeta = None

    @field_validator("generated_at", "expires_at")
    @classmethod
    def _rfc3339_timestamp(cls, value: str | None) -> str | None:
        if value is not None:
            return _validate_rfc3339(value)
        return value

    @model_validator(mode="after")
    def _semantic_constraints(self) -> "A2UIFormDocumentV1":
        _validate_document_semantics(self)
        return self


class ResolveClient(A2UIModel):
    supported_schema_versions: Annotated[list[Annotated[str, Field(pattern=_SEMVER_PATTERN)]], Field(min_length=1)] = Field(
        alias="supportedSchemaVersions"
    )
    supported_components: Annotated[list[ComponentType], Field(min_length=1)] = Field(
        alias="supportedComponents"
    )
    locale: Annotated[str, Field(min_length=2, max_length=35)] = None
    time_zone: Annotated[str, Field(min_length=1, max_length=100)] = Field(
        default=None, alias="timeZone"
    )

    @model_validator(mode="after")
    def _unique_capabilities(self) -> "ResolveClient":
        if len(set(self.supported_schema_versions)) != len(self.supported_schema_versions):
            raise ValueError("supportedSchemaVersions must be unique")
        if len(set(self.supported_components)) != len(self.supported_components):
            raise ValueError("supportedComponents must be unique")
        return self


class FormResolveRequestV1(A2UIModel):
    """Untrusted resolve input; authentication is deliberately absent."""

    schema_version: SchemaVersion = Field(alias="schemaVersion")
    request_id: StableId = Field(alias="requestId")
    form_key: StableId = Field(alias="formKey")
    context: dict[str, Any] = None
    client: ResolveClient

    @field_validator("context", mode="before")
    @classmethod
    def _untrusted_json_context(cls, value: Any) -> dict[str, Any] | None:
        if value is None:
            return value
        return _ensure_json_object(value)


class SubmissionAction(A2UIModel):
    action_id: StableId = Field(alias="actionId")
    source_component_id: StableId = Field(alias="sourceComponentId")


class SubmissionClient(A2UIModel):
    locale: Annotated[str, Field(min_length=2, max_length=35)] = None
    time_zone: Annotated[str, Field(min_length=1, max_length=100)] = Field(
        default=None, alias="timeZone"
    )


class FormSubmitRequestV1(A2UIModel):
    schema_version: SchemaVersion = Field(alias="schemaVersion")
    request_id: StableId = Field(alias="requestId")
    idempotency_key: StableId = Field(alias="idempotencyKey")
    form_id: StableId = Field(alias="formId")
    revision: Annotated[int, Field(ge=1)]
    action: SubmissionAction
    data: dict[str, Any]
    client: SubmissionClient = None

    @field_validator("data", mode="before")
    @classmethod
    def _submission_json(cls, value: Any) -> dict[str, Any]:
        return _ensure_json_object(value)


class GeneralErrorV1(A2UIModel):
    code: ProtocolErrorName
    message: Annotated[str, Field(min_length=1, max_length=500)]
    retryable: bool


class FieldErrorV1(A2UIModel):
    code: ProtocolErrorName
    message: Annotated[str, Field(min_length=1, max_length=500)]
    component_id: StableId = Field(default=None, alias="componentId")


class FormResolveErrorV1(A2UIModel):
    schema_version: SchemaVersion = Field(alias="schemaVersion")
    request_id: StableId = Field(alias="requestId")
    form_key: StableId = Field(alias="formKey")
    status: Literal["error"]
    errors: Annotated[list[GeneralErrorV1], Field(min_length=1)]


class SubmitResult(A2UIModel):
    submission_id: StableId = Field(alias="submissionId")
    message: Annotated[str, Field(max_length=500)] = None


class FormSubmitSuccessV1(A2UIModel):
    schema_version: SchemaVersion = Field(alias="schemaVersion")
    request_id: StableId = Field(alias="requestId")
    form_id: StableId = Field(alias="formId")
    status: Literal["success"]
    result: SubmitResult


class FormSubmitValidationErrorV1(A2UIModel):
    schema_version: SchemaVersion = Field(alias="schemaVersion")
    request_id: StableId = Field(alias="requestId")
    form_id: StableId = Field(alias="formId")
    status: Literal["validation_error"]
    field_errors: dict[str, Annotated[list[FieldErrorV1], Field(min_length=1)]] = Field(
        alias="fieldErrors"
    )
    errors: list[GeneralErrorV1] = None

    @field_validator("field_errors")
    @classmethod
    def _field_error_paths(cls, value: dict[str, list[FieldErrorV1]]) -> dict[str, list[FieldErrorV1]]:
        if not value:
            raise ValueError("fieldErrors must not be empty")
        for path in value:
            _validate_data_path(path)
        return value


class FormSubmitErrorV1(A2UIModel):
    schema_version: SchemaVersion = Field(alias="schemaVersion")
    request_id: StableId = Field(alias="requestId")
    form_id: StableId = Field(alias="formId")
    status: Literal["error"]
    errors: Annotated[list[GeneralErrorV1], Field(min_length=1)]


FormSubmitResponseV1: TypeAlias = Union[
    FormSubmitSuccessV1,
    FormSubmitValidationErrorV1,
    FormSubmitErrorV1,
]
A2UIApiMessageV1: TypeAlias = Union[
    FormResolveRequestV1,
    FormResolveErrorV1,
    FormSubmitRequestV1,
    FormSubmitSuccessV1,
    FormSubmitValidationErrorV1,
    FormSubmitErrorV1,
]


def _validate_data_path(value: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(_DATA_PATH_PATTERN, value):
        raise ValueError("value must be an absolute JSON Pointer")
    if len(value) > 512:
        raise ValueError("JSON Pointer is too long")


def _decode_pointer_token(token: str) -> str:
    return token.replace("~1", "/").replace("~0", "~")


def _pointer_tokens(pointer: str) -> list[str]:
    """Decode a JSON Pointer (RFC 6901) into its decoded token list.

    The empty string and ``"/"`` both yield the empty list (document root).
    """
    if not pointer or pointer == "/":
        return []
    return [_decode_pointer_token(token) for token in pointer.removeprefix("/").split("/")]


def _apply_setvalue_effect(initial_values: dict[str, Any], pointer: str, value: Any) -> dict[str, Any]:
    """Return a deep copy of *initial_values* with *value* set at *pointer*.

    Intermediate dicts are created for non-existent tokens when the preceding
    token resolves to a dict (allowable for ancestor-replace overlaps).
    """
    result = copy.deepcopy(initial_values)
    tokens = _pointer_tokens(pointer)
    if not tokens:
        return result
    target: Any = result
    for token in tokens[:-1]:
        if isinstance(target, dict):
            if token not in target:
                target[token] = {}
            target = target[token]
        elif isinstance(target, list):
            index = int(token)
            if index >= len(target):
                return result
            target = target[index]
        else:
            return result
    last = tokens[-1]
    if isinstance(target, dict):
        target[last] = value
    elif isinstance(target, list):
        target[int(last)] = value
    return result


def _resolve_pointer(document: Any, pointer: str) -> Any:
    value = document
    for raw_token in pointer.removeprefix("/").split("/"):
        token = _decode_pointer_token(raw_token)
        if type(value) is dict:
            if token not in value:
                raise KeyError(pointer)
            value = value[token]
        elif type(value) is list:
            if not token.isdecimal() or (len(token) > 1 and token.startswith("0")):
                raise KeyError(pointer)
            index = int(token)
            if index >= len(value):
                raise KeyError(pointer)
            value = value[index]
        else:
            raise KeyError(pointer)
    return value


def _walk_nodes(node: ComponentNode) -> list[ComponentNode]:
    nodes = [node]
    for child in node.children:
        nodes.extend(_walk_nodes(child))
    return nodes


def _condition_nodes(condition: Condition, depth: int = 1) -> tuple[int, int]:
    if isinstance(condition, LogicalCondition):
        counts = [_condition_nodes(child, depth + 1) for child in condition.args]
        return max([depth, *(child_depth for child_depth, _ in counts)]), 1 + sum(
            count for _, count in counts
        )
    if isinstance(condition, NotCondition):
        child_depth, child_count = _condition_nodes(condition.arg, depth + 1)
        return max(depth, child_depth), 1 + child_count
    return depth, 1


def _condition_paths(condition: Condition) -> list[DataPath]:
    if isinstance(condition, (ValueCondition, PathCondition)):
        return [condition.path]
    if isinstance(condition, LogicalCondition):
        return [path for child in condition.args for path in _condition_paths(child)]
    return _condition_paths(condition.arg)


def _validate_condition_types(condition: Condition, initial_values: dict[str, Any]) -> None:
    if isinstance(condition, LogicalCondition):
        for child in condition.args:
            _validate_condition_types(child, initial_values)
        return
    if isinstance(condition, NotCondition):
        _validate_condition_types(condition.arg, initial_values)
        return
    if not isinstance(condition, ValueCondition):
        return

    try:
        source_value = _resolve_pointer(initial_values, condition.path)
    except KeyError as exc:
        raise _SemanticIssue(ProtocolErrorCode.RULE_INVALID) from exc

    if condition.op in {"greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"}:
        if _is_number(source_value) and _is_number(condition.value):
            return
        if type(source_value) is str and type(condition.value) is str:
            try:
                datetime.fromisoformat(f"{source_value}T00:00:00")
                datetime.fromisoformat(f"{condition.value}T00:00:00")
            except ValueError as exc:
                raise _SemanticIssue(ProtocolErrorCode.RULE_INVALID) from exc
            return
        raise _SemanticIssue(ProtocolErrorCode.RULE_INVALID)


def _validate_input_value(node: ComponentNode, value: Any) -> None:
    component_type = node.type
    if component_type in {"TextInput", "TextArea"}:
        if value is not None and type(value) is not str:
            raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID)
    elif component_type == "DatePicker":
        if value is not None:
            if type(value) is not str:
                raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID)
            try:
                datetime.fromisoformat(f"{value}T00:00:00")
            except ValueError as exc:
                raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID) from exc
    elif component_type == "NumberInput":
        if value is not None and not _is_number(value):
            raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID)
    elif component_type in {"Select", "RadioGroup"}:
        if value is not None and not _is_scalar(value):
            raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID)
        props = _PROP_MODELS[component_type].model_validate(node.props)
        options = getattr(props, "options", None)
        if value is not None and options is not None:
            if not any(_same_json_scalar(value, option.value) for option in options):
                raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID)
    elif component_type == "CheckboxGroup":
        if type(value) is not list or not all(_is_scalar(item) for item in value):
            raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID)
        seen: set[tuple[type[Any], Any]] = set()
        for item in value:
            marker = _json_scalar_marker(item)
            if marker in seen:
                raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID)
            seen.add(marker)
        props = ChoiceProps.model_validate(node.props)
        if not all(
            any(_same_json_scalar(item, option.value) for option in props.options)
            for item in value
        ):
            raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID)
    elif component_type == "Switch":
        if type(value) is not bool:
            raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID)
    elif component_type == "Upload":
        if type(value) is not list:
            raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID)
        for item in value:
            try:
                UploadValueV1.model_validate(item)
            except ValidationError as exc:
                raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID) from exc


class UploadValueV1(A2UIModel):
    # The profile intentionally leaves file-reference business constraints to
    # the trusted upload host.  Keep this shape-only: no product-specific file
    # name, quota, or MIME policy belongs in the shared model layer.
    file_id: str = Field(alias="fileId")
    name: str
    size: float | int
    mime_type: str = Field(alias="mimeType")
    status: Literal["uploaded"]

    @field_validator("size")
    @classmethod
    def _finite_size(cls, value: float | int) -> float | int:
        if not _is_number(value):
            raise ValueError("upload size must be a finite number")
        return value


def _assert_acyclic(graph: dict[str, set[str]]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visiting:
            raise _SemanticIssue(ProtocolErrorCode.RULE_INVALID)
        if node in visited:
            return
        visiting.add(node)
        for target in graph.get(node, set()):
            visit(target)
        visiting.remove(node)
        visited.add(node)

    for source in graph:
        visit(source)


# Validator → compatible component value types.
# When the value type is statically ambiguous (e.g. Select / RadioGroup can
# hold any scalar), the validator is rejected — this is an explicit, testable
# rule that prevents the Python model, frontend renderer, and submission
# validator from diverging.
_VALIDATOR_TYPE_MATRIX: dict[str, frozenset[str]] = {
    "required": frozenset(
        {*_INPUT_COMPONENT_TYPES}
    ),
    "minLength": frozenset({"TextInput", "TextArea", "DatePicker"}),
    "maxLength": frozenset({"TextInput", "TextArea", "DatePicker"}),
    "pattern": frozenset({"TextInput", "TextArea", "DatePicker"}),
    "minItems": frozenset({"CheckboxGroup", "Upload"}),
    "maxItems": frozenset({"CheckboxGroup", "Upload"}),
    "minimum": frozenset({"NumberInput"}),
    "maximum": frozenset({"NumberInput"}),
    "integer": frozenset({"NumberInput"}),
}


def _validate_validator_bounds(node: ComponentNode) -> None:
    if not node.validation:
        return
    values: dict[str, float | int] = {}
    for validator in node.validation:
        if isinstance(validator, LengthValidator):
            values[validator.type] = validator.value
        elif isinstance(validator, NumberValidator):
            values[validator.type] = validator.value
    if values.get("minLength", 0) > values.get("maxLength", float("inf")):
        raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)
    if values.get("minItems", 0) > values.get("maxItems", float("inf")):
        raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)
    if values.get("minimum", float("-inf")) > values.get("maximum", float("inf")):
        raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)


def _validate_validator_compatibility(node: ComponentNode) -> None:
    """Reject validators that are incompatible with the component's value type."""
    if not node.validation:
        return
    component_type = node.type
    for validator in node.validation:
        allowed = _VALIDATOR_TYPE_MATRIX.get(validator.type)
        if allowed is None:
            raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)
        if component_type not in allowed:
            raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)


def _validate_document_semantics(document: A2UIFormDocumentV1) -> None:
    nodes = _walk_nodes(document.root)
    if document.root.type != "Form" or any(node.type == "Form" for node in nodes[1:]):
        raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)

    node_ids = [node.id for node in nodes]
    if len(node_ids) != len(set(node_ids)):
        raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)
    nodes_by_id = {node.id: node for node in nodes}

    action_ids = [action.id for action in document.actions]
    if len(action_ids) != len(set(action_ids)):
        raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)
    actions_by_id = {action.id: action for action in document.actions}

    data_sources = document.data_sources or []
    source_ids = [source.id for source in data_sources]
    if len(source_ids) != len(set(source_ids)):
        raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)
    sources_by_id = {source.id: source for source in data_sources}

    if document.generated_at is not None and document.expires_at is not None:
        generated = datetime.fromisoformat(document.generated_at.replace("Z", "+00:00"))
        expires = datetime.fromisoformat(document.expires_at.replace("Z", "+00:00"))
        if expires <= generated:
            raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)

    # Build dataPath → bound component mapping for setValue type validation.
    _path_components: dict[str, list[ComponentNode]] = {}
    for node in nodes:
        if node.type in _INPUT_COMPONENT_TYPES and node.data_path:
            _path_components.setdefault(node.data_path, []).append(node)

    for node in nodes:
        _validate_validator_bounds(node)
        _validate_validator_compatibility(node)
        if node.type in _INPUT_COMPONENT_TYPES:
            try:
                value = _resolve_pointer(document.data.initial_values, node.data_path or "")
            except KeyError as exc:
                raise _SemanticIssue(ProtocolErrorCode.DATA_BINDING_INVALID) from exc
            _validate_input_value(node, value)

        if node.action is not None:
            action = actions_by_id.get(node.action.action_id)
            if action is None:
                raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)
            if node.type == "Upload" and not isinstance(action, UploadAction):
                raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)
            if node.type == "Button" and not isinstance(action, (SubmitAction, ResetAction)):
                raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)

        if node.type == "Select":
            props = SelectProps.model_validate(node.props)
            if props.data_source_id is not None and props.data_source_id not in sources_by_id:
                raise _SemanticIssue(ProtocolErrorCode.SCHEMA_SEMANTIC_INVALID)

    rules = document.rules or []
    rule_ids = [rule.id for rule in rules]
    if len(rule_ids) != len(set(rule_ids)):
        raise _SemanticIssue(ProtocolErrorCode.RULE_INVALID)
    graph: dict[str, set[str]] = {}
    for rule in rules:
        max_depth, count = _condition_nodes(rule.when)
        if max_depth > 10 or count > 100:
            raise _SemanticIssue(ProtocolErrorCode.RULE_INVALID)
        try:
            _resolve_pointer(document.data.initial_values, rule.source_data_path)
            for path in _condition_paths(rule.when):
                _resolve_pointer(document.data.initial_values, path)
        except KeyError as exc:
            raise _SemanticIssue(ProtocolErrorCode.RULE_INVALID) from exc
        _validate_condition_types(rule.when, document.data.initial_values)
        for effect in [*rule.then, *(rule.else_ or [])]:
            if isinstance(effect, ComponentStateEffect):
                if effect.target_component_id not in nodes_by_id:
                    raise _SemanticIssue(ProtocolErrorCode.RULE_INVALID)
            else:
                try:
                    _resolve_pointer(document.data.initial_values, effect.target_data_path)
                except KeyError as exc:
                    raise _SemanticIssue(ProtocolErrorCode.RULE_INVALID) from exc
                graph.setdefault(rule.source_data_path, set()).add(effect.target_data_path)
                # Validate setValue value type against every component whose
                # dataPath overlaps with the target (exact, ancestor, or descendant).
                effect_tokens = _pointer_tokens(effect.target_data_path)
                for bound_path, bound_nodes in _path_components.items():
                    bound_tokens = _pointer_tokens(bound_path)
                    is_exact = bound_tokens == effect_tokens
                    # bound is ancestor of effect: effect modifies a sub-path of the bound value.
                    bound_is_ancestor = (
                        len(bound_tokens) < len(effect_tokens)
                        and bound_tokens == effect_tokens[: len(bound_tokens)]
                    )
                    # effect is ancestor of bound: effect replaces a parent containing the bound value.
                    effect_is_ancestor = (
                        len(effect_tokens) < len(bound_tokens)
                        and effect_tokens == bound_tokens[: len(effect_tokens)]
                    )
                    if is_exact:
                        for bound_node in bound_nodes:
                            _validate_input_value(bound_node, effect.value)
                    elif bound_is_ancestor or effect_is_ancestor:
                        simulated = _apply_setvalue_effect(
                            document.data.initial_values,
                            effect.target_data_path,
                            effect.value,
                        )
                        try:
                            new_value = _resolve_pointer(simulated, bound_path)
                        except KeyError:
                            raise _SemanticIssue(
                                ProtocolErrorCode.RULE_INVALID
                            ) from None
                        for bound_node in bound_nodes:
                            _validate_input_value(bound_node, new_value)
    _assert_acyclic(graph)


def _require_schema_version(payload: Any) -> Mapping[str, Any]:
    if not isinstance(payload, Mapping):
        raise ProtocolValidationError(ProtocolErrorCode.SCHEMA_INVALID)
    version = payload.get("schemaVersion")
    if version is None:
        raise ProtocolValidationError(ProtocolErrorCode.SCHEMA_INVALID)
    if version != A2UI_FORM_SCHEMA_VERSION:
        raise ProtocolValidationError(ProtocolErrorCode.SCHEMA_VERSION_UNSUPPORTED)
    return payload


def _document_has_unknown_component(payload: Mapping[str, Any]) -> bool:
    def visit(node: Any) -> bool:
        if not isinstance(node, Mapping):
            return False
        component_type = node.get("type")
        if component_type is not None and component_type not in SUPPORTED_COMPONENT_TYPES:
            return True
        children = node.get("children", [])
        return isinstance(children, list) and any(visit(child) for child in children)

    return visit(payload.get("root"))


def _protocol_error_from_validation(
    error: ValidationError, payload: Mapping[str, Any], *, document: bool = False
) -> ProtocolValidationError:
    for item in error.errors():
        nested = item.get("ctx", {}).get("error")
        if isinstance(nested, _SemanticIssue):
            return ProtocolValidationError(nested.code)
    if document and _document_has_unknown_component(payload):
        return ProtocolValidationError(ProtocolErrorCode.COMPONENT_UNSUPPORTED)
    return ProtocolValidationError(ProtocolErrorCode.SCHEMA_INVALID)


def validate_form_document(payload: Any) -> A2UIFormDocumentV1:
    """Parse a complete v1 document or raise a stable protocol error."""

    checked = _require_schema_version(payload)
    try:
        return A2UIFormDocumentV1.model_validate(checked)
    except ValidationError as exc:
        raise _protocol_error_from_validation(exc, checked, document=True) from None


def validate_form_resolve_request(payload: Any) -> FormResolveRequestV1:
    """Parse untrusted resolve input; it intentionally yields no principal."""

    checked = _require_schema_version(payload)
    try:
        return FormResolveRequestV1.model_validate(checked)
    except ValidationError as exc:
        raise _protocol_error_from_validation(exc, checked) from None


def validate_form_submit_request(payload: Any) -> FormSubmitRequestV1:
    """Parse the submission envelope only, not its future business semantics."""

    checked = _require_schema_version(payload)
    try:
        return FormSubmitRequestV1.model_validate(checked)
    except ValidationError as exc:
        raise _protocol_error_from_validation(exc, checked) from None


def validate_api_message(payload: Any) -> A2UIApiMessageV1:
    """Parse one frozen API-schema envelope without adding endpoint behavior."""

    checked = _require_schema_version(payload)
    try:
        if "formKey" in checked:
            if checked.get("status") == "error":
                return FormResolveErrorV1.model_validate(checked)
            return FormResolveRequestV1.model_validate(checked)
        if "idempotencyKey" in checked:
            return FormSubmitRequestV1.model_validate(checked)
        if checked.get("status") == "success":
            return FormSubmitSuccessV1.model_validate(checked)
        if checked.get("status") == "validation_error":
            return FormSubmitValidationErrorV1.model_validate(checked)
        if checked.get("status") == "error":
            return FormSubmitErrorV1.model_validate(checked)
    except ValidationError as exc:
        raise _protocol_error_from_validation(exc, checked) from None
    raise ProtocolValidationError(ProtocolErrorCode.SCHEMA_INVALID)


LogicalCondition.model_rebuild()
NotCondition.model_rebuild()
ComponentNode.model_rebuild()


__all__ = [
    "A2UI_FORM_SCHEMA_VERSION",
    "A2UIApiMessageV1",
    "A2UIFormDocumentV1",
    "ActionBinding",
    "ActionDefinition",
    "ComponentNode",
    "ComponentType",
    "Condition",
    "FieldErrorV1",
    "FormResolveErrorV1",
    "FormResolveRequestV1",
    "FormSubmitErrorV1",
    "FormSubmitRequestV1",
    "FormSubmitResponseV1",
    "FormSubmitSuccessV1",
    "FormSubmitValidationErrorV1",
    "GeneralErrorV1",
    "LinkRule",
    "ProtocolErrorCode",
    "ProtocolValidationError",
    "RemoteOptionsSource",
    "RuleEffect",
    "SUPPORTED_COMPONENT_TYPES",
    "UploadValueV1",
    "Validator",
    "validate_api_message",
    "validate_form_document",
    "validate_form_resolve_request",
    "validate_form_submit_request",
]
