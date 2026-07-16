"""The agent loop — the only file you need to read to understand everything.

~70 lines. One while loop. No magic.
"""

from __future__ import annotations

import json
from pathlib import Path

from openai import OpenAI

from .checkpoint import load as load_checkpoint
from .checkpoint import save as save_checkpoint
from .config import load_provider
from .tools import ToolRegistry
from .types import AgentState, Message


def run(
    prompt: str,
    registry: ToolRegistry,
    *,
    system: str | None = None,
    profile: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    max_steps: int = 20,
    checkpoint_dir: str = "checkpoints",
    resume: bool = False,
    verbose: bool = True,
) -> str:
    """
    运行 agent 循环。

    Args:
        prompt: 用户输入。
        registry: 工具注册表。
        system: 系统提示词（可选）。
        profile: profiles.yaml 中的 provider 名称，如 "deepseek"。
                 优先级：profile > AGENT_PROFILE 环境变量 > .env
        model/base_url/api_key: 直接指定时覆盖 profile 中的值。
        max_steps: 最大步数，防止无限循环。
        checkpoint_dir: 存档目录。
        resume: 是否从上次存档恢复。
        verbose: 是否打印每一步。
    """
    provider = load_provider(profile)
    client = OpenAI(
        base_url=base_url or provider["base_url"],
        api_key=api_key or provider["api_key"],
    )
    model = model or provider["model"]
    tools = registry.tool_schemas() or None

    # ── Load or create state ──────────────────────────────────
    if resume:
        state = load_checkpoint(checkpoint_dir=checkpoint_dir)
        if state is None:
            _log("未找到存档，从头开始。", verbose)
            state = AgentState()
        else:
            _log(f"从 {state.checkpoint_id} 恢复（第 {state.step} 步）", verbose)
    else:
        state = AgentState()

    # ── Build initial messages ────────────────────────────────
    if state.step == 0:
        if system:
            state.messages.append(Message(role="system", content=system))
        state.messages.append(Message(role="user", content=prompt))
    elif prompt:
        # 多轮对话：追加新的用户消息
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
            _log(f"完成：{content[:200]}", verbose)
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
                result_str = f"工具出错：{e}"
                _log(f"✗ 工具出错：{e}", verbose)

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
        _log(f"异常终止（{choice.finish_reason}）：{content[:200]}", verbose)
        save_checkpoint(state, checkpoint_dir)
        return content

    # Max steps exceeded
    _log(f"\n⚠ 已达最大步数限制（{max_steps} 步）。", verbose)
    return "[MAX_STEPS] Agent 未在步数限制内完成任务。"


def _log(msg: str, verbose: bool) -> None:
    if verbose:
        print(msg)
