"""Checkpoint — save/restore agent state to JSON files.

Every step the agent takes is persisted. If the process dies, restart and
pick up where you left off. No database needed — just a directory.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .types import AgentState, Message

DEFAULT_DIR = Path("checkpoints")


def save(state: AgentState, checkpoint_dir: str | Path = DEFAULT_DIR) -> str:
    """Persist AgentState to a JSON file. Returns the checkpoint id."""
    cdir = Path(checkpoint_dir)
    cdir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    cid = f"ckpt-{ts}-step{state.step:04d}"
    path = cdir / f"{cid}.json"

    with open(path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "checkpoint_id": cid,
                "step": state.step,
                "messages": [_message_to_dict(m) for m in state.messages],
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    state.checkpoint_id = cid
    return cid


def load(checkpoint_id: str | None = None, checkpoint_dir: str | Path = DEFAULT_DIR) -> AgentState | None:
    """Restore the latest checkpoint, or a specific one by id."""
    cdir = Path(checkpoint_dir)

    if checkpoint_id:
        path = cdir / f"{checkpoint_id}.json"
        if not path.exists():
            return None
        return _load_file(path)

    # Pick latest by filename
    files = sorted(cdir.glob("ckpt-*.json"), reverse=True)
    if not files:
        return None
    return _load_file(files[0])


def list_checkpoints(checkpoint_dir: str | Path = DEFAULT_DIR) -> list[str]:
    """List all checkpoint ids, newest first."""
    cdir = Path(checkpoint_dir)
    if not cdir.exists():
        return []
    return sorted(
        [p.stem for p in cdir.glob("ckpt-*.json")],
        reverse=True,
    )


# ── internal ─────────────────────────────────────────────────────


def _message_to_dict(m: Message) -> dict:
    d: dict = {"role": m.role}
    if m.content is not None:
        d["content"] = m.content
    if m.tool_calls is not None:
        d["tool_calls"] = m.tool_calls
    if m.tool_call_id is not None:
        d["tool_call_id"] = m.tool_call_id
    if m.name is not None:
        d["name"] = m.name
    return d


def _load_file(path: Path) -> AgentState:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    messages = []
    for m in data.get("messages", []):
        messages.append(
            Message(
                role=m.get("role", "user"),
                content=m.get("content"),
                tool_calls=m.get("tool_calls"),
                tool_call_id=m.get("tool_call_id"),
                name=m.get("name"),
            )
        )

    return AgentState(
        messages=messages,
        step=data.get("step", 0),
        checkpoint_id=data.get("checkpoint_id"),
    )
