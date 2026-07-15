"""Smoke tests for agent-core."""

import json
import tempfile
from pathlib import Path

import pytest

from agent_core import Message, ToolRegistry
from agent_core.checkpoint import load, save, list_checkpoints
from agent_core.tools import Tool
from agent_core.types import AgentState


class TestMessage:
    def test_to_openai_minimal(self):
        m = Message(role="user", content="hello")
        assert m.to_openai() == {"role": "user", "content": "hello"}

    def test_to_openai_with_tool_calls(self):
        m = Message(
            role="assistant",
            content=None,
            tool_calls=[{"id": "1", "type": "function", "function": {"name": "f", "arguments": "{}"}}],
        )
        d = m.to_openai()
        assert d["role"] == "assistant"
        # content is None → not included in dict (OpenAI API convention)
        assert d["tool_calls"] is not None


class TestToolRegistry:
    def test_register_and_schema(self):
        reg = ToolRegistry()

        @reg.register(description="Add two numbers")
        def add(a: int, b: int) -> int:
            return a + b

        schemas = reg.tool_schemas()
        assert len(schemas) == 1
        fn = schemas[0]["function"]
        assert fn["name"] == "add"
        assert "a" in fn["parameters"]["properties"]

    def test_execute(self):
        reg = ToolRegistry()

        @reg.register(description="Greet")
        def greet(name: str) -> str:
            return f"Hello {name}"

        assert reg.execute("greet", {"name": "World"}) == "Hello World"

    def test_unknown_tool(self):
        reg = ToolRegistry()
        with pytest.raises(ValueError, match="Unknown tool"):
            reg.execute("nonexistent", {})


class TestCheckpoint:
    def test_save_and_load(self):
        state = AgentState(messages=[Message(role="user", content="hi")], step=3)
        with tempfile.TemporaryDirectory() as tmp:
            cid = save(state, checkpoint_dir=tmp)
            assert cid.startswith("ckpt-")

            restored = load(checkpoint_dir=tmp)
            assert restored is not None
            assert restored.step == 3
            assert restored.messages[0].content == "hi"

    def test_list(self):
        state = AgentState(step=1)
        with tempfile.TemporaryDirectory() as tmp:
            save(state, checkpoint_dir=tmp)
            import time; time.sleep(1.1)  # avoid filename collision (same-second)
            save(state, checkpoint_dir=tmp)
            ckpts = list_checkpoints(checkpoint_dir=tmp)
            assert len(ckpts) == 2

    def test_load_nonexistent(self):
        with tempfile.TemporaryDirectory() as tmp:
            assert load(checkpoint_dir=tmp) is None
