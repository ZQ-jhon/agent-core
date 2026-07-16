"""Provider 配置 — 从 profiles.yaml 或环境变量加载。

优先级：命令行 --profile > AGENT_PROFILE 环境变量 > .env 回退
"""

from __future__ import annotations

import os
from pathlib import Path

import yaml


def load_provider(profile: str | None = None) -> dict[str, str]:
    """加载 provider 配置。返回 {'base_url': ..., 'api_key': ..., 'model': ...}

    查找顺序：
    1. 如果指定了 profile，从 profiles.yaml 加载
    2. 如果设置了 AGENT_PROFILE 环境变量，用它
    3. 回退到 .env 中的 OPENAI_* 环境变量
    """
    profile = profile or os.getenv("AGENT_PROFILE")
    if profile:
        return _load_from_file(profile)

    return _load_from_env()


def _load_from_file(profile: str) -> dict[str, str]:
    path = _find_profiles_yaml()
    if not path:
        raise FileNotFoundError(
            f"未找到 profiles.yaml，请先创建。参考 profiles.example.yaml"
        )

    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    if profile not in data:
        available = ", ".join(data.keys())
        raise ValueError(
            f"未找到 profile '{profile}'，可用的：{available}"
        )

    cfg = data[profile]
    required = ["base_url", "api_key", "model"]
    missing = [k for k in required if k not in cfg]
    if missing:
        raise ValueError(f"profile '{profile}' 缺少字段：{', '.join(missing)}")

    return {
        "base_url": cfg["base_url"],
        "api_key": cfg["api_key"],
        "model": cfg.get("model", "gpt-4o"),
    }


def _load_from_env() -> dict[str, str]:
    return {
        "base_url": os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        "api_key": os.getenv("OPENAI_API_KEY", ""),
        "model": os.getenv("OPENAI_MODEL", "gpt-4o"),
    }


def _find_profiles_yaml() -> Path | None:
    """从当前目录向上查找 profiles.yaml"""
    cwd = Path.cwd()
    for parent in [cwd] + list(cwd.parents):
        f = parent / "profiles.yaml"
        if f.exists():
            return f
    return None
