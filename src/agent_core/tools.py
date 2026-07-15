"""Tool registry — define callable functions and their JSON schemas."""

from __future__ import annotations

import inspect
from typing import Any, Callable

# ── Tool definition ──────────────────────────────────────────────


class Tool:
    def __init__(self, fn: Callable, name: str, description: str, parameters: dict[str, Any]):
        self.fn = fn
        self.name = name
        self.description = description
        self.parameters = parameters

    def to_openai(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def __call__(self, **kwargs: Any) -> Any:
        return self.fn(**kwargs)


# ── Registry ─────────────────────────────────────────────────────


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(
        self,
        fn: Callable | None = None,
        *,
        name: str | None = None,
        description: str | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> Callable:
        """Decorator — auto-extracts signature for JSON schema."""

        def _decorator(f: Callable) -> Callable:
            tool_name = name or f.__name__
            tool_desc = description or (f.__doc__ or "").strip().split("\n")[0]
            tool_params = parameters or _signature_to_schema(f)

            self._tools[tool_name] = Tool(f, tool_name, tool_desc, tool_params)
            return f

        if fn is not None:
            return _decorator(fn)
        return _decorator

    def tool_schemas(self) -> list[dict[str, Any]]:
        return [t.to_openai() for t in self._tools.values()]

    def execute(self, name: str, arguments: dict[str, Any]) -> Any:
        tool = self._tools.get(name)
        if tool is None:
            raise ValueError(f"Unknown tool: {name}")
        return tool(**arguments)

    def __contains__(self, name: str) -> bool:
        return name in self._tools


# ── Helpers ──────────────────────────────────────────────────────


def _signature_to_schema(fn: Callable) -> dict[str, Any]:
    """Convert a function signature to a JSON Schema object."""
    sig = inspect.signature(fn)
    props: dict[str, Any] = {}
    required: list[str] = []

    for pname, param in sig.parameters.items():
        if pname in ("self", "cls"):
            continue
        ptype = "string"
        if param.annotation is not inspect.Parameter.empty:
            anno = param.annotation
            if anno is int:
                ptype = "integer"
            elif anno is float:
                ptype = "number"
            elif anno is bool:
                ptype = "boolean"
            elif anno is list:
                ptype = "array"

        props[pname] = {"type": ptype}
        if param.default is inspect.Parameter.empty:
            required.append(pname)

    return {
        "type": "object",
        "properties": props,
        "required": required,
    }
