"""The agent loop — the only file you need to read to understand everything.

~70 lines. One while loop. No magic.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from openai import OpenAI

from .checkpoint import load as load_checkpoint
from .checkpoint import save as save_checkpoint
from .tools import ToolRegistry
from .types import AgentState, Message


def run(
    prompt: str,
    registry: ToolRegistry,
    *,
    system: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    max_steps: int = 20,
    checkpoint_dir: str = "checkpoints",
    resume: bool = False,
    verbose: bool = True,
) -> str:
    """
    Run the agent loop.

    Args:
        prompt: The user's request.
        registry: A ToolRegistry with registered tools.
        system: Optional system prompt.
        model: Model name (default: env OPENAI_MODEL or gpt-4o).
        base_url: API base url (default: env OPENAI_BASE_URL).
        api_key: API key (default: env OPENAI_API_KEY).
        max_steps: Safety limit to prevent infinite loops.
        checkpoint_dir: Where checkpoints are stored.
        resume: If True, load last checkpoint and continue.
        verbose: Print each step.
    """
    # ── Setup ─────────────────────────────────────────────────
    client = OpenAI(
        base_url=base_url or os.getenv("OPENAI_BASE_URL"),
        api_key=api_key or os.getenv("OPENAI_API_KEY"),
    )
    model = model or os.getenv("OPENAI_MODEL", "gpt-4o")
    tools = registry.tool_schemas() or None

    # ── Load or create state ──────────────────────────────────
    if resume:
        state = load_checkpoint(checkpoint_dir=checkpoint_dir)
        if state is None:
            _log("No checkpoint found, starting fresh.", verbose)
            state = AgentState()
        else:
            _log(f"Resumed from {state.checkpoint_id} (step {state.step})", verbose)
    else:
        state = AgentState()

    # ── Build initial messages ────────────────────────────────
    if state.step == 0:
        if system:
            state.messages.append(Message(role="system", content=system))
        state.messages.append(Message(role="user", content=prompt))

    # ── The loop ──────────────────────────────────────────────
    while state.step < max_steps:
        state.step += 1
        _log(f"\n── Step {state.step} ──", verbose)

        # Call the model
        response = client.chat.completions.create(
            model=model,
            messages=[m.to_openai() for m in state.messages],
            tools=tools,
        )
        choice = response.choices[0]

        # Model wants to respond with text → we're done
        if choice.finish_reason == "stop":
            content = choice.message.content or ""
            state.messages.append(Message(role="assistant", content=content))
            _log(f"Done: {content[:200]}", verbose)
            save_checkpoint(state, checkpoint_dir)
            return content

        # Model wants to call tools
        if choice.message.tool_calls:
            tc = choice.message.tool_calls[0]
            tool_name = tc.function.name
            tool_args = json.loads(tc.function.arguments)

            _log(f"→ {tool_name}({json.dumps(tool_args, ensure_ascii=False)})", verbose)

            # Record assistant's tool call
            state.messages.append(
                Message(
                    role="assistant",
                    content=choice.message.content,
                    tool_calls=[
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {"name": tool_name, "arguments": tc.function.arguments},
                        }
                    ],
                )
            )

            # Execute the tool
            try:
                result = registry.execute(tool_name, tool_args)
                result_str = str(result)
            except Exception as e:
                result_str = f"Error: {e}"
                _log(f"✗ Tool error: {e}", verbose)

            _log(f"← {result_str[:200]}", verbose)

            # Record tool result
            state.messages.append(
                Message(role="tool", content=result_str, tool_call_id=tc.id, name=tool_name)
            )

            # Persist after every tool execution
            save_checkpoint(state, checkpoint_dir)
            continue

        # Unexpected finish reason (length, content_filter, etc.)
        content = choice.message.content or ""
        state.messages.append(Message(role="assistant", content=content))
        _log(f"Stopped ({choice.finish_reason}): {content[:200]}", verbose)
        save_checkpoint(state, checkpoint_dir)
        return content

    # Max steps exceeded
    _log(f"\n⚠ Max steps ({max_steps}) reached.", verbose)
    return "[MAX_STEPS] Agent did not finish within step limit."


def _log(msg: str, verbose: bool) -> None:
    if verbose:
        print(msg)
