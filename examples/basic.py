"""Example: Agent with search and calculation tools.

To run:
    1. cp .env.example .env   (edit with your API key)
    2. uv run python examples/basic.py
"""

from agent_core import ToolRegistry, run

# ── Define tools ──────────────────────────────────────────────

registry = ToolRegistry()


@registry.register(description="Search the web for current information")
def web_search(query: str) -> str:
    """MOCK — replace with real search API (SerpAPI, Tavily, etc.)"""
    return (
        f'Search results for "{query}":\n'
        "1. Python 3.13 released with experimental JIT compiler\n"
        "2. OpenAI announces GPT-5 preview for enterprise\n"
        "3. TypeScript 6.0 adds native type inference for AI workflows"
    )


@registry.register(description="Evaluate a mathematical expression. Supports +, -, *, /, **.")
def calculate(expression: str) -> str:
    """Evaluate a math expression. Uses Python eval with safety restrictions."""
    # Safety: only allow numbers, operators, parens, spaces
    allowed = set("0123456789+-*/().^ ")
    if not all(c in allowed for c in expression):
        return f"Error: expression contains disallowed characters: {expression}"
    # Replace ^ with ** for exponentiation
    expr = expression.replace("^", "**")
    try:
        result = eval(expr, {"__builtins__": {}})
        return str(result)
    except Exception as e:
        return f"Error evaluating expression: {e}"


# ── Run ───────────────────────────────────────────────────────

if __name__ == "__main__":
    result = run(
        prompt="搜索最新的 Python 版本，然后计算 2026 减 1994 等于多少",
        registry=registry,
        system="你是一个有帮助的助手。使用中文回答。每次只调用一个工具，收到结果后再决定下一步。",
        resume=False,
    )
    print(f"\n{'='*60}")
    print(f"Final answer:\n{result}")
