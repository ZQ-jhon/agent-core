from __future__ import annotations

import json
from collections.abc import Iterable
from copy import deepcopy
from datetime import date
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "docs/a2ui/v1/schema/a2ui-form-v1.schema.json"
API_SCHEMA_PATH = ROOT / "docs/a2ui/v1/schema/a2ui-api-v1.schema.json"
EXAMPLES_PATH = ROOT / "docs/a2ui/v1/form-examples-v1.json"
TYPES_PATH = ROOT / "docs/a2ui/v1/types/a2ui-form-v1.ts"
VALIDATION_PATH = ROOT / "docs/a2ui/v1/validation-and-actions-v1.md"

EXPECTED_EXAMPLES = {
    "single-field-update",
    "conditional-application",
    "remote-options-application",
}
INPUT_TYPES = {
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
LEAF_TYPES = INPUT_TYPES | {"Button", "Alert", "Markdown"}


def load_contract() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    bundle = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))
    return schema, bundle["examples"]


def walk_nodes(node: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield node
    for child in node["children"]:
        yield from walk_nodes(child)


def decode_pointer_token(token: str) -> str:
    return token.replace("~1", "/").replace("~0", "~")


def resolve_pointer(document: Any, pointer: str) -> Any:
    value = document
    for raw_token in pointer.removeprefix("/").split("/"):
        token = decode_pointer_token(raw_token)
        if isinstance(value, list):
            value = value[int(token)]
        else:
            value = value[token]
    return value


def condition_paths(condition: dict[str, Any]) -> Iterable[str]:
    if "path" in condition:
        yield condition["path"]
    for child in condition.get("args", []):
        yield from condition_paths(child)
    if "arg" in condition:
        yield from condition_paths(condition["arg"])


def assert_default_type(node: dict[str, Any], value: Any) -> None:
    component_type = node["type"]
    if component_type in {"TextInput", "TextArea", "DatePicker"}:
        assert value is None or isinstance(value, str)
        if component_type == "DatePicker" and value is not None:
            date.fromisoformat(value)
    elif component_type == "NumberInput":
        assert value is None or (
            isinstance(value, (int, float)) and not isinstance(value, bool)
        )
    elif component_type in {"Select", "RadioGroup"}:
        assert value is None or (
            isinstance(value, (str, int, float, bool)) and not isinstance(value, list)
        )
    elif component_type in {"CheckboxGroup", "Upload"}:
        assert isinstance(value, list)
    elif component_type == "Switch":
        assert isinstance(value, bool)


def assert_acyclic(graph: dict[str, set[str]]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visiting:
            raise AssertionError(f"cyclic setValue dependency at {node}")
        if node in visited:
            return
        visiting.add(node)
        for target in graph.get(node, set()):
            visit(target)
        visiting.remove(node)
        visited.add(node)

    for node in graph:
        visit(node)


def test_examples_match_json_schema() -> None:
    schema, examples = load_contract()
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())

    assert {example["formId"] for example in examples} == EXPECTED_EXAMPLES
    for example in examples:
        errors = sorted(validator.iter_errors(example), key=lambda error: list(error.path))
        assert not errors, "\n".join(
            f"/{'/'.join(map(str, error.path))}: {error.message}" for error in errors
        )


def test_examples_have_valid_references_and_data_bindings() -> None:
    _, examples = load_contract()

    for example in examples:
        nodes = list(walk_nodes(example["root"]))
        nodes_by_id = {node["id"]: node for node in nodes}
        assert len(nodes_by_id) == len(nodes), "component ids must be unique"
        assert nodes[0]["type"] == "Form"
        assert all(node["type"] != "Form" for node in nodes[1:])
        assert all(not node["children"] for node in nodes if node["type"] in LEAF_TYPES)

        actions = {action["id"]: action for action in example["actions"]}
        assert len(actions) == len(example["actions"]), "action ids must be unique"
        data_sources = {
            source["id"]: source for source in example.get("dataSources", [])
        }
        assert len(data_sources) == len(example.get("dataSources", []))

        initial_values = example["data"]["initialValues"]
        for node in nodes:
            if node["type"] in INPUT_TYPES:
                value = resolve_pointer(initial_values, node["dataPath"])
                assert_default_type(node, value)

            if "action" in node:
                action = actions[node["action"]["actionId"]]
                if node["type"] == "Upload":
                    assert action["type"] == "upload"
                if node["type"] == "Button":
                    assert action["type"] in {"submit", "reset"}

            data_source_id = node["props"].get("dataSourceId")
            if data_source_id:
                assert data_source_id in data_sources

        rules = example.get("rules", [])
        assert len({rule["id"] for rule in rules}) == len(rules)
        set_value_graph: dict[str, set[str]] = {}
        for rule in rules:
            resolve_pointer(initial_values, rule["sourceDataPath"])
            for path in condition_paths(rule["when"]):
                resolve_pointer(initial_values, path)
            for effect in rule["then"] + rule.get("else", []):
                if effect["type"] in {"setVisible", "setDisabled"}:
                    assert effect["targetComponentId"] in nodes_by_id
                else:
                    resolve_pointer(initial_values, effect["targetDataPath"])
                    set_value_graph.setdefault(rule["sourceDataPath"], set()).add(
                        effect["targetDataPath"]
                    )
        assert_acyclic(set_value_graph)


def test_examples_do_not_contain_executable_configuration() -> None:
    _, examples = load_contract()
    forbidden_keys = {
        "eval",
        "expression",
        "function",
        "headers",
        "javascript",
        "script",
        "url",
    }

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            assert forbidden_keys.isdisjoint(key.lower() for key in value)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(examples)


def test_examples_are_minimal_and_cover_agent_task_shapes() -> None:
    _, examples = load_contract()
    examples_by_id = {example["formId"]: example for example in examples}

    editable_counts = {
        form_id: sum(
            node["type"] in INPUT_TYPES
            for node in walk_nodes(example["root"])
        )
        for form_id, example in examples_by_id.items()
    }
    assert editable_counts["single-field-update"] == 1
    assert all(count <= 7 for count in editable_counts.values())

    conditional = examples_by_id["conditional-application"]
    assert conditional["rules"]
    assert any(
        effect["type"] in {"setVisible", "setDisabled", "setValue"}
        for rule in conditional["rules"]
        for effect in rule["then"] + rule.get("else", [])
    )

    remote = examples_by_id["remote-options-application"]
    assert remote["dataSources"]
    assert any(source["type"] == "remoteOptions" for source in remote["dataSources"])


def test_remote_options_execution_semantics_are_registry_owned() -> None:
    schema, examples = load_contract()
    remote_definition = schema["$defs"]["remoteOptionsSource"]
    forbidden_execution_fields = {
        "method",
        "query",
        "response",
        "dependsOn",
        "debounceMs",
        "minQueryLength",
        "cacheTtlSeconds",
    }

    assert remote_definition["required"] == ["id", "type", "endpointKey"]
    assert set(remote_definition["properties"]) == {"id", "type", "endpointKey"}

    remote_example = next(
        example
        for example in examples
        if example["formId"] == "remote-options-application"
    )
    source = remote_example["dataSources"][0]
    assert source["endpointKey"] == "locations.cities"
    assert forbidden_execution_fields.isdisjoint(source)

    mismatched_schema_configs = [
        {
            "query": [
                {
                    "name": "unregisteredCountryParam",
                    "source": {
                        "kind": "data",
                        "path": "/destination/countryCode",
                    },
                }
            ]
        },
        {
            "query": [
                {
                    "name": "countryCode",
                    "source": {
                        "kind": "data",
                        "path": "/unapproved/source/path",
                    },
                }
            ]
        },
        {
            "response": {
                "itemsPath": "/unexpected/items",
                "labelPath": "/display",
                "valuePath": "/key",
            }
        },
    ]
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    for mismatch in mismatched_schema_configs:
        invalid_document = deepcopy(remote_example)
        invalid_document["dataSources"][0].update(mismatch)
        assert list(validator.iter_errors(invalid_document)), mismatch


def test_completed_idempotent_replay_precedes_current_revision_validation() -> None:
    contract = VALIDATION_PATH.read_text(encoding="utf-8")
    ordered_markers = [
        "认证/授权、严格包络解析以及 path/body 一致性校验",
        "原子查询记录并比较规范化请求指纹",
        "已有同 key、同指纹且已完成的记录必须直接回放",
        "仅在记录不存在时，服务端才校验当前 revision、action、source 绑定",
    ]
    marker_positions = [contract.index(marker) for marker in ordered_markers]

    assert marker_positions == sorted(marker_positions)
    assert "客户端以 rev4 成功提交但响应丢失，随后表单升为 rev5" in contract
    assert "回放 rev4 已持久化的响应" in contract


def test_schema_types_and_examples_share_the_same_catalog() -> None:
    schema, examples = load_contract()
    typescript = TYPES_PATH.read_text(encoding="utf-8")
    remote_options_type = typescript.partition(
        "export interface RemoteOptionsSource {"
    )[2].partition("}\n")[0]
    catalog = (ROOT / "docs/a2ui/v1/component-catalog-v1.md").read_text(
        encoding="utf-8"
    )
    schema_types = set(
        schema["$defs"]["componentNode"]["properties"]["type"]["enum"]
    )
    example_types = {
        node["type"]
        for example in examples
        for node in walk_nodes(example["root"])
    }

    assert schema_types == example_types
    assert schema["properties"]["schemaVersion"]["const"] == "1.0.0"
    assert 'A2UI_FORM_SCHEMA_VERSION = "1.0.0"' in typescript
    assert "export interface FormResolveErrorV1" in typescript
    assert "idempotencyKey: StableId;" in typescript
    assert "result: { submissionId: StableId;" in typescript
    assert {
        line.strip()
        for line in remote_options_type.splitlines()
        if line.strip()
    } == {
        "id: StableId;",
        'type: "remoteOptions";',
        "endpointKey: string;",
    }
    for component_type in schema_types:
        assert f'"{component_type}"' in typescript
        assert f"### {component_type}" in catalog


def test_api_message_examples_match_api_schema() -> None:
    api_schema = json.loads(API_SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(api_schema)
    validator = Draft202012Validator(api_schema, format_checker=FormatChecker())
    messages = [
        {
            "schemaVersion": "1.0.0",
            "requestId": "req-resolve-001",
            "formKey": "travel-application",
            "context": {"conversationId": "conv-001"},
            "client": {
                "supportedSchemaVersions": ["1.0.0"],
                "supportedComponents": ["Form", "Section", "TextInput", "Button"],
                "locale": "zh-CN",
                "timeZone": "Asia/Shanghai",
            },
        },
        {
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
        },
        {
            "schemaVersion": "1.0.0",
            "requestId": "req-resolve-001",
            "formKey": "travel-application",
            "status": "error",
            "errors": [
                {
                    "code": "CLIENT_CAPABILITY_MISMATCH",
                    "message": "客户端能力不足",
                    "retryable": False,
                }
            ],
        },
        {
            "schemaVersion": "1.0.0",
            "requestId": "req-submit-001",
            "formId": "travel-application",
            "status": "success",
            "result": {
                "submissionId": "submission-01J2ABC",
                "message": "提交成功",
            },
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
                        "message": "所选城市当前不可用",
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
                    "message": "表单已更新，请重新加载",
                    "retryable": True,
                }
            ],
        },
    ]

    for message in messages:
        errors = list(validator.iter_errors(message))
        assert not errors, "\n".join(error.message for error in errors)


def test_api_schema_rejects_ambiguous_resolve_and_submit_messages() -> None:
    api_schema = json.loads(API_SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(api_schema, format_checker=FormatChecker())
    resolve_error_validator = Draft202012Validator(
        {
            "$ref": "#/$defs/formResolveError",
            "$defs": api_schema["$defs"],
        },
        format_checker=FormatChecker(),
    )

    valid_submit_request = {
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
    }
    valid_submit_success = {
        "schemaVersion": "1.0.0",
        "requestId": "req-submit-001",
        "formId": "travel-application",
        "status": "success",
        "result": {"submissionId": "submission-01J2ABC"},
    }
    valid_resolve_error = {
        "schemaVersion": "1.0.0",
        "requestId": "req-resolve-001",
        "formKey": "travel-application",
        "status": "error",
        "errors": [
            {
                "code": "CLIENT_CAPABILITY_MISMATCH",
                "message": "客户端能力不足",
                "retryable": False,
            }
        ],
    }

    invalid_messages = []

    missing_idempotency_key = dict(valid_submit_request)
    missing_idempotency_key.pop("idempotencyKey")
    invalid_messages.append(missing_idempotency_key)

    missing_result = dict(valid_submit_success)
    missing_result.pop("result")
    invalid_messages.append(missing_result)

    missing_submission_id = dict(valid_submit_success)
    missing_submission_id["result"] = {"message": "提交成功"}
    invalid_messages.append(missing_submission_id)

    submit_error_shape_used_for_resolve = dict(valid_resolve_error)
    submit_error_shape_used_for_resolve.pop("formKey")
    submit_error_shape_used_for_resolve["formId"] = "invented-form-id"

    missing_resolve_errors = dict(valid_resolve_error)
    missing_resolve_errors.pop("errors")
    invalid_messages.append(missing_resolve_errors)

    assert not list(validator.iter_errors(valid_submit_request))
    assert not list(validator.iter_errors(valid_submit_success))
    assert not list(validator.iter_errors(valid_resolve_error))
    assert list(resolve_error_validator.iter_errors(submit_error_shape_used_for_resolve))
    for message in invalid_messages:
        assert list(validator.iter_errors(message)), message
