from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# ── OpenAI-compatible message types ──────────────────────────────


@dataclass
class Message:
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None
    name: str | None = None

    def to_openai(self) -> dict[str, Any]:
        """Convert to OpenAI API dict, dropping None fields."""
        msg: dict[str, Any] = {"role": self.role}
        if self.content is not None:
            msg["content"] = self.content
        if self.tool_calls is not None:
            msg["tool_calls"] = self.tool_calls
        if self.tool_call_id is not None:
            msg["tool_call_id"] = self.tool_call_id
        if self.name is not None:
            msg["name"] = self.name
        return msg


# ── Agent State ──────────────────────────────────────────────────


@dataclass
class AgentState:
    messages: list[Message] = field(default_factory=list)
    step: int = 0
    checkpoint_id: str | None = None
